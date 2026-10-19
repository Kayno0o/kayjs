import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { islandPrefix, pageIds, withPageToken } from '../src/runtime/uid.server'
import { pages } from '../src/server'

const FIELD = '---\nimport { uid } from \'kay\'\n\nconst { label } = props<{ label: string }>()\nconst id = uid()\n---\nlabel(for={id}) {label}\ninput(id={id})\n'
const MENU = '---\nimport { signal, uid } from \'kay\'\n\nconst open = signal(false)\nconst id = uid()\n---\nbutton(aria-controls={id} onClick={() => open.set(o => !o)}) Menu\nul(id={id})\n'
const PAGE = '--- server\nimport { defer } from \'kay\'\n\nconst outer = defer(new Promise<string>(resolve => setTimeout(resolve, 5, \'outer\')))\nconst inner = defer(new Promise<string>(resolve => setTimeout(resolve, 15, \'inner\')))\n--- script\nimport Field from \'../components/field.kay\'\nimport Menu from \'../components/menu.kay\'\n---\nmain\n  Field(label="Name")\n  Menu\n  // kay-allow uncaught-await\n  await outer\n    p.waiting Waiting\n  then text\n    p {text}\n    Field(label="Inside")\n    // kay-allow uncaught-await\n    await inner\n      p.waiting Waiting more\n    then more\n      p {more}\n      Field(label="Nested")\n'
const SHELL = '---\nimport { signal } from \'kay\'\n\nconst open = signal(false)\n---\nsection(onClick={() => open.set(o => !o)})\n  slot\n'
const KEPT = '--- script\nimport Field from \'../components/field.kay\'\nimport Menu from \'../components/menu.kay\'\nimport Shell from \'../components/shell.kay\'\n---\nmain\n  Shell(persist="chat")\n    Field(label="Slotted")\n    Menu\n'
const OTHER = '--- script\nimport Field from \'../components/field.kay\'\nimport Menu from \'../components/menu.kay\'\nimport Shell from \'../components/shell.kay\'\n---\nmain\n  Menu\n  Field(label="Before")\n  Field(label="Before too")\n  Shell(persist="chat")\n    Field(label="Slotted")\n    Menu\n  Field(label="After")\n'
const ID = /\bid="([^"]+)"/g
const AWAIT = /data-kay-await="([^"]+)"/g
const root = process.cwd()

describe('the ids of a page rendered per request', () => {
  let dir = ''
  let app: Awaited<ReturnType<typeof pages>>

  const read = async (path: string): Promise<string> => {
    const response = await app.handle(new Request(`http://localhost${path}`, { headers: { 'accept-encoding': 'identity' } }))

    expect(response.status).toBe(200)

    return response.text()
  }
  const ids = (html: string) => [...html.matchAll(ID)].map(match => match[1]!)

  beforeAll(async () => {
    dir = await mkdtemp(join(root, '.kay/routes-'))
    await Bun.write(join(dir, 'components/field.kay'), FIELD)
    await Bun.write(join(dir, 'components/menu.kay'), MENU)
    await Bun.write(join(dir, 'routes/index.kay'), PAGE)
    await Bun.write(join(dir, 'routes/about.kay'), PAGE)
    app = await pages({ routes: join(dir, 'routes'), prebuilt: true })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('gives the same bytes on every visit, streamed blocks and the ids of components alike, so a compressed copy of it is kept', async () => {
    const [first, second] = [await read('/'), await read('/')]

    expect(ids(first).length).toBe(4)
    expect(new Set(ids(first)).size).toBe(4)
    expect(ids(first).some(id => id.includes('_0_0-'))).toBe(true)
    expect(second).toBe(first)
  })

  it('numbers the blocks of a page from zero, those inside a streamed block under its id and an underscore, each once in the document', async () => {
    const html = await read('/')
    const blocks = [...html.matchAll(AWAIT)].map(match => match[1]!)

    expect(blocks).toEqual(['0', '0_0'])
    expect(html.match(/<!--kay-await:0_0-->/g)).toHaveLength(1)
    expect(html).toContain('Waiting')
    expect(html).toContain('outer')
    expect(html).toContain('inner')
  })

  it('gives each URL ids of its own, so a page swapped in beside a kept island shares none with the one it replaces', async () => {
    const [home, about, search] = [await read('/'), await read('/about'), await read('/?page=2')]
    const seen = new Set(ids(home))

    for (const other of [about, search])
      expect(ids(other).filter(id => seen.has(id))).toEqual([])

    expect(ids(about).filter(id => ids(search).includes(id))).toEqual([])
  })

  it('keeps the ids of renders running together to their own URL', async () => {
    const paths = ['/', '/about', '/?page=2', '/about?page=2']
    const htmls = await Promise.all(Array.from({ length: 24 }, async (_, index) => read(paths[index % paths.length]!)))

    for (const [index, html] of htmls.entries())
      expect(html).toBe(htmls[index % paths.length]!)
  })
})

describe('the prefix of a persistent island', () => {
  const render = async (before: number): Promise<{ kept: string, others: string[] }> => withPageToken('kabc', async () => pageIds(() => {
    const others = Array.from({ length: before }, () => islandPrefix())

    return { kept: islandPrefix('chat'), others: [...others, islandPrefix()] }
  }))

  it('comes from its key, not its place, so the same URL rendered with another island before it keeps it and shares it with no other', async () => {
    const [old, next] = [await render(0), await render(2)]

    expect(next.kept).toBe(old.kept)
    expect([...next.others, ...old.others]).not.toContain(old.kept)
  })

  it('tells two islands of one key apart', async () => {
    const [first, second] = await withPageToken('kabc', async () => pageIds(() => [islandPrefix('chat'), islandPrefix('chat')]))

    expect(second).not.toBe(first)
  })
})

describe('the ids in the slots of a persistent island', () => {
  let dir = ''
  let app: Awaited<ReturnType<typeof pages>>

  const read = async (path: string): Promise<string> => withPageToken('kabc', async () => (await app.handle(new Request(`http://localhost${path}`, { headers: { 'accept-encoding': 'identity' } }))).text())
  const ids = (html: string) => [...html.matchAll(ID)].map(match => match[1]!)

  beforeAll(async () => {
    dir = await mkdtemp(join(root, '.kay/routes-'))
    await Bun.write(join(dir, 'components/field.kay'), FIELD)
    await Bun.write(join(dir, 'components/menu.kay'), MENU)
    await Bun.write(join(dir, 'components/shell.kay'), SHELL)
    await Bun.write(join(dir, 'routes/index.kay'), KEPT)
    await Bun.write(join(dir, 'routes/other.kay'), OTHER)
    app = await pages({ routes: join(dir, 'routes'), prebuilt: true })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('come from the island\'s key, so a page at the same URL with other islands and fields before it and the islands inside them repeat none of the kept ones', async () => {
    const [kept, other] = [await read('/'), await read('/other')]
    const slotted = ids(kept)

    expect(slotted).toHaveLength(2)
    expect(new Set(ids(other)).size).toBe(6)
    // Only the kept island's own slot, the same on both pages, repeats.
    expect(ids(other).filter(id => slotted.includes(id))).toEqual(slotted)
    expect(slotted.every(id => id.includes('-p'))).toBe(true)
  })
})
