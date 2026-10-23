import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'bun:test'
import { devUi, devUiWrite } from '../src/server/dev-ui'
import { scratchDir } from './scratch'

const PANEL = '---\nimport { recipe } from \'kay\'\nconst look = recipe({ parts: { root: \'p-2\', body: \'text-sm\' }, variants: { size: { sm: \'text-sm\', lg: \'text-lg\' } } })\n---\ndiv(part="root")\n  div(part="body")\n    slot\n'
const PANEL_FILE = 'src/components/panel.kay'
const CARD_FILE = join(import.meta.dir, '..', 'packages', 'ui', 'src', 'card.kay')

describe('the Styles tab\'s endpoints', () => {
  let root = ''

  const put = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), text)
  }

  const ui = async () => readFile(join(root, 'src/ui.ts'), 'utf8')

  const read = async (file: string, headers: Record<string, string> = { 'x-kay-dev': '1' }) => devUi(root, new Request(`http://localhost/_kay/dev/ui?file=${encodeURIComponent(file)}`, { headers }))

  const write = async (body: object, headers: Record<string, string> = { 'x-kay-dev': '1' }) => devUiWrite(root, new Request('http://localhost/_kay/dev/ui', { method: 'POST', headers, body: JSON.stringify(body) }))

  beforeEach(async () => {
    root = await scratchDir('dev-ui-')
    await put('package.json', '{ "name": "dev-ui", "type": "module", "dependencies": { "kay": "*", "@kaynooo/kayjs-ui": "*" } }\n')
    await put(PANEL_FILE, PANEL)
    await put('src/components/plain.kay', 'div Plain\n')
  })

  it('refuses a request without the dev header and one from another site', async () => {
    expect((await read(PANEL_FILE, {})).status).toBe(403)
    expect((await read(PANEL_FILE, { 'x-kay-dev': '1', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await write({ file: PANEL_FILE, part: 'body', classes: 'p-4' }, { 'x-kay-dev': '1', 'origin': 'https://evil.example' })).status).toBe(403)
    expect((await write({ file: PANEL_FILE, part: 'body', classes: 'p-4' }, {})).status).toBe(403)
    await expect(Bun.file(join(root, 'src/ui.ts')).exists()).resolves.toBe(false)
  })

  it('describes a component\'s parts, variants and the entry src/ui.ts already holds', async () => {
    await put('src/ui.ts', 'import { defineUi } from \'kay\'\n\nexport default defineUi({\n  Panel: { parts: { body: \'p-9\' } },\n})\n')

    const view = await (await read(PANEL_FILE)).json() as { name: string, key: string, exists: boolean, parts: { name: string, classes: string, set?: string }[], variants: Record<string, string[]> }

    expect(view).toMatchObject({ name: 'Panel', key: 'Panel', exists: true, variants: { size: ['sm', 'lg'] } })
    expect(view.parts.find(part => part.name === 'body')).toEqual({ name: 'body', classes: 'text-sm', set: 'p-9' })
    expect(view.parts.find(part => part.name === 'root')?.set).toBeUndefined()
  })

  it('lists a library component\'s tokens from the theme', async () => {
    const view = await (await read(CARD_FILE)).json() as { name: string, tokens: { name: string }[] }

    expect(view.name).toBe('Card')
    expect(view.tokens.map(token => token.name)).toContain('--kui-border-width')
  })

  it('has nothing for a component without parts, a page and a file that is not a component', async () => {
    expect((await read('src/components/plain.kay')).status).toBe(404)
    expect((await read('src/missing.kay')).status).toBe(404)
    expect((await read('package.json')).status).toBe(400)
    expect((await write({ file: PANEL_FILE, part: 'nope', classes: 'p-4' })).status).toBe(404)
  })

  it('creates src/ui.ts when the app has none', async () => {
    expect(await (await write({ file: PANEL_FILE, part: 'body', classes: '  p-4   gap-2 ' })).json()).toEqual({ key: 'Panel', created: true })
    expect(await ui()).toBe('import { defineUi } from \'kay\'\n\nexport default defineUi({\n  Panel: { parts: { body: \'p-4 gap-2\' } },\n})\n')
  })

  it('adds an entry, a parts object and a part to a src/ui.ts that exists, keeping the rest as written', async () => {
    const head = 'import { defineUi } from \'kay\'\n\n// Kept.\nexport default defineUi({\n  Badge: { parts: \'rounded\' },\n'

    await put('src/ui.ts', `${head}})\n`)
    await write({ file: PANEL_FILE, part: 'body', classes: 'p-4' })
    expect(await ui()).toBe(`${head}  Panel: { parts: { body: 'p-4' } },\n})\n`)

    await put('src/ui.ts', `${head}  Panel: { variants: { size: { sm: { root: 'p-1' } } } },\n})\n`)
    await write({ file: PANEL_FILE, part: 'root', classes: 'p-4' })
    expect(await ui()).toBe(`${head}  Panel: { variants: { size: { sm: { root: 'p-1' } } }, parts: { root: 'p-4' } },\n})\n`)

    await write({ file: PANEL_FILE, part: 'body', classes: 'it\'s' })
    expect(await ui()).toContain('parts: { root: \'p-4\', body: \'it\\\'s\' }')

    await write({ file: PANEL_FILE, part: 'body', classes: 'p-6' })
    expect(await ui()).toContain('parts: { root: \'p-4\', body: \'p-6\' }')
  })

  it('writes into an entry written with a string, a trailing comma, no comma, and under its specifier', async () => {
    await put('src/ui.ts', 'import { defineUi } from \'kay\'\n\nexport default defineUi({\n  Panel: { parts: \'p-1\' }\n})\n')
    await write({ file: PANEL_FILE, part: 'body', classes: 'p-2' })
    expect(await ui()).toContain('Panel: { parts: { root: \'p-1\', body: \'p-2\' } }')

    await put('src/ui.ts', 'import { defineUi } from \'kay\'\n\nexport default defineUi({\n  \'./components/panel.kay\': { parts: { body: \'x\', }, },\n})\n')
    await write({ file: PANEL_FILE, part: 'root', classes: 'p-2' })
    expect(await ui()).toContain('\'./components/panel.kay\': { parts: { body: \'x\', root: \'p-2\', }, }')
  })

  it('refuses to guess at a file it cannot edit in place, and leaves it as it is', async () => {
    const dynamic = 'import { defineUi } from \'kay\'\n\nconst body = \'p-1\'\n\nexport default defineUi({\n  Panel: { parts: { body } },\n})\n'

    await put('src/ui.ts', dynamic)
    expect((await write({ file: PANEL_FILE, part: 'root', classes: 'p-2' })).status).toBe(200)
    expect((await write({ file: PANEL_FILE, part: 'body', classes: 'p-2' })).status).toBe(422)

    await put('src/ui.ts', 'export const nothing = 1\n')
    expect((await write({ file: PANEL_FILE, part: 'body', classes: 'p-2' })).status).toBe(422)
    expect(await ui()).toBe('export const nothing = 1\n')

    await put('src/ui.ts', 'export default defineUi({ Panel: tweaks })\n')
    expect((await write({ file: PANEL_FILE, part: 'body', classes: 'p-2' })).status).toBe(422)
  })

  it('keys a library component by its name', async () => {
    await write({ file: CARD_FILE, part: 'head', classes: 'p-8' })
    expect(await ui()).toContain('Card: { parts: { head: \'p-8\' } }')
  })

  it('refuses classes that are not one line of text', async () => {
    expect((await write({ file: PANEL_FILE, part: 'body', classes: 'a\u0000b' })).status).toBe(400)
    expect((await write({ file: PANEL_FILE, part: 'body', classes: 3 })).status).toBe(400)
    expect((await write({ file: '../../etc/passwd', part: 'body', classes: 'a' })).status).toBe(400)
  })
})
