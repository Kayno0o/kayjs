import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { icons } from '../../plugin-icons/src/plugin'
import { findIcons, relatedWords } from '../../plugin-icons/src/search'
import { replaceTable } from '../../plugin-icons/src/table'

// Each test swaps in the small table it needs, so the shipped one can change without moving these cases.
beforeEach(() => replaceTable({}))

describe('findIcons', () => {
  it('lists the exact name first, then names starting with the query, then names holding it', () => {
    expect(findIcons(['arrow-home', 'home-2', 'home'], 'home')).toEqual(['home', 'home-2', 'arrow-home'])
  })

  it('reads the spaces of a query as the dashes of a name', () => {
    expect(findIcons(['cart', 'shopping-cart'], 'shopping cart')).toEqual(['shopping-cart', 'cart'])
  })

  it('adds the icons a related word names after the literal matches', () => {
    replaceTable({ trash: 'delete 80' })

    expect(findIcons(['circle', 'delete', 'trash-x'], 'trash')).toEqual(['trash-x', 'delete'])
  })

  it('ranks related icons by how strongly their word is related', () => {
    replaceTable({ bin: 'delete 40 trash 90' })

    expect(findIcons(['delete', 'trash'], 'bin')).toEqual(['trash', 'delete'])
  })

  it('ranks an icon whose name is only the related word above one where it is one word of several', () => {
    replaceTable({ bin: 'trash 90' })

    expect(findIcons(['trash-off', 'trash'], 'bin')).toEqual(['trash', 'trash-off'])
  })

  it('finds a misspelled word one edit away', () => {
    expect(findIcons(['shopping-cart', 'bag'], 'shoping')).toEqual(['shopping-cart'])
  })

  it('finds two letters swapped as one edit', () => {
    expect(findIcons(['bell', 'calendar'], 'blel')).toEqual(['bell'])
  })

  it('takes two edits from a word of eight letters, one below', () => {
    expect(findIcons(['notebook', 'keyboard'], 'notbokk')).toEqual([])
    expect(findIcons(['notebook', 'keyboard'], 'notbookk')).toEqual(['notebook'])
  })

  it('leaves a word the names already know as it is, rather than respelling it', () => {
    expect(findIcons(['card', 'cart'], 'card')).toEqual(['card'])
  })

  it('completes a half-typed word into a table word and follows its related words', () => {
    replaceTable({ shopping: 'cart 80' })

    expect(findIcons(['bag', 'cart'], 'shopp')).toEqual(['cart'])
  })

  // `boo x` holds no name literally, so only completions of `boo` answer.
  it('completes a half-typed word into its three most used name words, the shortest first among equals', () => {
    expect(findIcons(['bookmark', 'bookmark-off', 'booklet', 'boost', 'books'], 'boo x')).toEqual(['bookmark', 'boost', 'books', 'bookmark-off'])
  })

  it('neither completes nor respells a word of two letters', () => {
    expect(findIcons(['arrow', 'upload'], 'up x')).toEqual([])
    expect(findIcons(['arrow', 'upload'], 'ux')).toEqual([])
  })

  it('follows the related words of a two-letter word the table knows', () => {
    replaceTable({ up: 'arrow 90' })

    expect(findIcons(['arrow', 'upload'], 'up')).toEqual(['upload', 'arrow'])
  })

  it('pages the literal and related matches as one list', () => {
    replaceTable({ bin: 'trash 90' })

    expect(findIcons(['bin-2', 'trash', 'bin'], 'bin', { offset: 1, limit: 2 })).toEqual(['bin-2', 'trash'])
  })

  it('lists every name for an empty query, paged', () => {
    expect(findIcons(['a', 'b', 'c'], '  ', { offset: 1, limit: 1 })).toEqual(['b'])
  })

  it('lists the names for an empty query without reading the word table', () => {
    replaceTable(new Proxy({}, { get: () => { throw new Error('read the table') }, has: () => { throw new Error('read the table') }, ownKeys: () => { throw new Error('read the table') } }))

    expect(findIcons(['home', 'star'], '', { limit: 1 })).toEqual(['home'])
  })

  // `dog` holds no name, so only the readings of `hous` answer: `house` by completion and respelling, `hour` by respelling.
  it('credits a word reached by both a completion and a respelling once', () => {
    expect(findIcons(['hour', 'house'], 'hous dog')).toEqual(['hour', 'house'])
  })

  it('counts a word repeated in the query once', () => {
    expect(findIcons(['trash', 'home'], 'trash home home')).toEqual(['trash', 'home'])
  })

  it('ranks an icon matching more of the query words above one matching fewer', () => {
    expect(findIcons(['left', 'arrow-big-left'], 'arrow left')).toEqual(['arrow-big-left', 'left'])
  })

  it('finds an icon named by one letter through a related word', () => {
    replaceTable({ close: 'x 80' })

    expect(findIcons(['lock-open', 'circle-x', 'x'], 'close')).toEqual(['x', 'circle-x'])
  })

  it('counts every segment of a name, so a variant ranks below the plain icon', () => {
    replaceTable({ add: 'plus 80' })

    expect(findIcons(['user-x', 'user-2', 'user', 'user-plus'], 'add user')).toEqual(['user-plus', 'user', 'user-x', 'user-2'])
  })

  it('respells a typo into the most used of equally close words', () => {
    expect(findIcons(['mark', 'dark', 'bark', 'park', 'park-car', 'park-bus'], 'tark')).toEqual(['dark', 'bark', 'park', 'park-car', 'park-bus'])
  })

  it('counts a query word once for an icon however many of its readings name it', () => {
    replaceTable({ bin: 'trash 90 delete 90', box: 'crate 10' })

    expect(findIcons(['delete-trash', 'crate-delete'], 'bin box')).toEqual(['crate-delete', 'delete-trash'])
  })

  it('reads a table replaced after the names were first searched', () => {
    const names = ['delete']

    expect(findIcons(names, 'trahs')).toEqual([])
    expect(findIcons(names, 'tra')).toEqual([])
    replaceTable({ trash: 'delete 80' })

    expect(findIcons(names, 'trahs')).toEqual(['delete'])
    expect(findIcons(names, 'tra')).toEqual(['delete'])
  })

  it('refuses a page that is not whole, a negative offset or a limit below 1', () => {
    const refusal = '@kayjs/icons: findIcons pages from a whole offset of 0 or more, by a whole limit of 1 or more: clamp the page a request asks for before searching.'

    expect(() => findIcons(['home'], 'home', { offset: -1 })).toThrow(refusal)
    expect(() => findIcons(['home'], 'home', { offset: 0.5 })).toThrow(refusal)
    expect(() => findIcons(['home'], 'home', { limit: 0 })).toThrow(refusal)
    expect(() => findIcons(['home'], 'home', { limit: 1.5 })).toThrow(refusal)
    expect(() => findIcons(['home'], 'home', { limit: Number.NaN })).toThrow(refusal)
    expect(findIcons(['home'], 'home', { offset: 0, limit: 1 })).toEqual(['home'])
  })
})

describe('relatedWords', () => {
  it('gives the words the table relates to a word, with their strength', () => {
    replaceTable({ bin: 'trash 90 delete 40' })

    expect(relatedWords('bin')).toEqual([['trash', 0.9], ['delete', 0.4]])
  })
})

describe('findIcons over an iconify set', () => {
  it('searches the names of its icons and of its aliases', () => {
    const set = { icons: { home: {}, star: {} }, aliases: { house: { parent: 'home' } } }

    expect(findIcons(set, 'ho')).toEqual(['home', 'house'])
  })
})

describe('kay icons-find', () => {
  const roots: string[] = []

  afterAll(() => {
    for (const root of roots)
      rmSync(root, { recursive: true, force: true })
  })

  function appWith(sets: Record<string, string[]>): string {
    const root = mkdtempSync(join(tmpdir(), 'kay-icons-find-'))
    roots.push(root)

    for (const [prefix, names] of Object.entries(sets)) {
      const dir = join(root, 'node_modules/@iconify-json', prefix)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'icons.json'), JSON.stringify({ prefix, icons: Object.fromEntries(names.map(name => [name, { body: '' }])) }))
    }

    return root
  }

  async function run(root: string, args: string[], options: Parameters<typeof icons>[0] = {}): Promise<string[]> {
    const log = spyOn(console, 'log').mockImplementation(() => {})

    try {
      await icons(options).commands!['icons-find']!(args, root)

      return log.mock.calls.map(call => String(call[0]))
    }
    finally {
      log.mockRestore()
    }
  }

  it('prints the import specifiers of every installed set matching the words, set by set', async () => {
    replaceTable({ garbage: 'trash 80' })
    const root = appWith({ tabler: ['trash', 'home'], lucide: ['trash-2'], mdi: ['trash-can'] })

    expect(await run(root, ['garbage'])).toEqual(['~icons/lucide/trash-2', '~icons/mdi/trash-can', '~icons/tabler/trash'])
  })

  it('finds a set hoisted to a parent folder, as a workspace installs it', async () => {
    const root = appWith({ tabler: ['home'] })
    mkdirSync(join(root, 'apps/site'), { recursive: true })

    expect(await run(join(root, 'apps/site'), ['home'])).toEqual(['~icons/tabler/home'])
  })

  it('takes a set from the nearest node_modules when a parent has it too', async () => {
    const root = appWith({ tabler: ['home-far'] })
    mkdirSync(join(root, 'apps/site/node_modules/@iconify-json/tabler'), { recursive: true })
    writeFileSync(join(root, 'apps/site/node_modules/@iconify-json/tabler/icons.json'), JSON.stringify({ prefix: 'tabler', icons: { 'home-near': { body: '' } } }))

    expect(await run(join(root, 'apps/site'), ['home'])).toEqual(['~icons/tabler/home-near'])
  })

  it('finds the sets of @iconify/json, an installed @iconify-json package first', async () => {
    const root = appWith({ mdi: ['home-outline'] })
    mkdirSync(join(root, 'node_modules/@iconify/json/json'), { recursive: true })
    writeFileSync(join(root, 'node_modules/@iconify/json/json/mdi.json'), JSON.stringify({ prefix: 'mdi', icons: { 'home-old': { body: '' } } }))
    writeFileSync(join(root, 'node_modules/@iconify/json/json/lucide.json'), JSON.stringify({ prefix: 'lucide', icons: { home: { body: '' } } }))

    expect(await run(root, ['home'])).toEqual(['~icons/lucide/home', '~icons/mdi/home-outline'])
  })

  it('searches the sets passed to icons() too', async () => {
    const root = appWith({ tabler: ['home'] })

    expect(await run(root, ['home'], { sets: { brand: { prefix: 'brand', icons: { 'home-logo': { body: '' } } } } })).toEqual(['~icons/brand/home-logo', '~icons/tabler/home'])
  })

  it('searches the app\'s folder of .svg files, as the set local', async () => {
    const root = appWith({ tabler: ['home'] })
    mkdirSync(join(root, 'src/icons'), { recursive: true })
    writeFileSync(join(root, 'src/icons/home-logo.svg'), '<svg viewBox="0 0 8 8"><rect/></svg>')

    expect(await run(root, ['home'])).toEqual(['~icons/local/home-logo', '~icons/tabler/home'])
  })

  it('searches only the set --set names, as many as --limit says', async () => {
    const root = appWith({ tabler: ['home', 'home-2', 'home-3'], lucide: ['home'] })

    expect(await run(root, ['home', '--set', 'tabler', '--limit', '2'])).toEqual(['~icons/tabler/home', '~icons/tabler/home-2'])
  })

  it('prints at most 10 icons per set', async () => {
    const root = appWith({ mini: ['home-a', 'home-b', 'home-c', 'home-d', 'home-e', 'home-f', 'home-g', 'home-h', 'home-i', 'home-j', 'home-k'] })

    expect(await run(root, ['home'])).toHaveLength(10)
  })

  it('fails when no icon set is installed', async () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const exit = spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit')
    })

    try {
      await expect(run(appWith({}), ['home'])).rejects.toThrow('exit')
      expect(error).toHaveBeenCalledWith('No icon set installed. Install one, such as @iconify-json/tabler.')
    }
    finally {
      error.mockRestore()
      exit.mockRestore()
    }
  })
})
