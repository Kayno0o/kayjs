import { afterAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { icons } from '../../plugin-icons/src/index'
import { findIcons } from '../../plugin-icons/src/search'
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

  async function run(root: string, args: string[]): Promise<string[]> {
    const log = spyOn(console, 'log').mockImplementation(() => {})

    try {
      await icons().commands!['icons-find']!(args, root)

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
