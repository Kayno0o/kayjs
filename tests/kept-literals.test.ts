import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { keptScan } from '../src/server/pure-page'
import { scratchDir } from './scratch'

const CLI = join(import.meta.dir, '../src/cli.ts')
const CONFIG = 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false })\n'
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('kept-imports-')

  roots.push(root)
  await Promise.all(Object.entries({ 'kay.config.ts': CONFIG, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

// Why the page at `src/routes/index.kay` is not kept, or undefined when it is.
async function stopOf(files: Record<string, string>, page = 'src/routes/index.kay'): Promise<string | undefined> {
  const root = await project(files)
  const { stop } = await keptScan({ file: join(root, page), layouts: [] }, undefined, root)

  return stop === undefined ? undefined : stop.why
}

async function built(root: string): Promise<string[]> {
  const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  if (code !== 0)
    throw new Error(`${out}${err}`)

  const manifest = await Bun.file(join(outputDir(root), 'manifest.json')).json() as { pages: Record<string, unknown> }

  return Object.keys(manifest.pages).sort()
}

const PAGE = (name: string, use = `${name}.email`) => `---\nimport { ${name} } from '../content'\n---\np {${use}}\n`
const CONTACT = 'export const CONTACT = { email: \'a@b.fr\', phone: \'01\', address: { city: \'Brest\', zip: \'29200\' } }\n'
const LIST = 'export const LIST = [\'a\', \'b\']\n'

describe('a page importing an exported object or array no module writes to', () => {
  it('is kept for an object, an array and a nested literal, with as const, satisfies or a type annotation', async () => {
    const contents: Record<string, readonly [string, string]> = {
      object: ['export const CONTACT = { email: \'a@b.fr\', phone: \'01\' }\n', 'CONTACT.email'],
      array: [LIST, 'LIST.length'],
      nested: [CONTACT, 'CONTACT.address.city'],
      asConst: ['export const CONTACT = { email: \'a@b.fr\', list: [1, -2, 3.5, true, null] } as const\n', 'CONTACT.email'],
      satisfies: ['export const CONTACT = { email: \'a@b.fr\' } satisfies Record<string, string>\n', 'CONTACT.email'],
      annotated: ['export const CONTACT: { email: string } = { email: \'l\\\'adresse\' }\n', 'CONTACT.email'],
      keys: ['export const CONTACT = { \'e-mail\': \'x\', 2: \'y\', trailing: [\'a\',], }\n', 'CONTACT[\'e-mail\']'],
      commented: ['// CONTACT is read only\nexport const CONTACT = {\n  // the address\n  email: \'x\', /* inline */ phone: \'y\',\n}\n', 'CONTACT.phone'],
      empty: ['export const CONTACT = {}\n', 'CONTACT.email'],
    }

    const files: Record<string, string> = {}

    for (const [key, [content, use]] of Object.entries(contents)) {
      const name = key.toUpperCase()
      const own = (text: string) => text.replaceAll('CONTACT', name).replaceAll('LIST', name)

      files[`src/${key}.ts`] = own(content)
      files[`src/routes/${key}.kay`] = `---\nimport { ${name} } from '../${key}'\n---\np {${own(use)}}\n`
    }

    for (const key of Object.keys(contents))
      expect([key, await stopOf(files, `src/routes/${key}.kay`)]).toEqual([key, undefined])
  })

  it('is kept when it iterates, spreads, destructures or lists a flat one', async () => {
    const files = {
      'src/content.ts': `${CONTACT}${LIST}export const FLAT = { email: 'a', phone: '1' }\nexport type Contact = typeof CONTACT\nexport const keys = Object.keys(CONTACT)\n`,
      'src/routes/index.kay': '---\nimport { CONTACT, FLAT, LIST } from \'../content\'\nimport type { Contact } from \'../content\'\n\nconst { email, phone } = FLAT\nconst copy = { ...CONTACT.address }\nconst more = [...LIST, \'c\']\nconst joined = LIST.map(item => item.toUpperCase()).join(\', \')\n---\nul\n  for (const item of LIST)\n    li {item}\np {email}{phone}{copy.city}{more.length}{joined}{Object.entries(CONTACT.address).length}{`${LIST[0]}`}{JSON.stringify(LIST)}\n',
    }

    expect(await stopOf(files)).toBeUndefined()
  })

  it('is kept when other files only mention its name, in a string, a comment or an import path', async () => {
    const files = {
      'src/content.ts': CONTACT,
      'src/routes/index.kay': PAGE('CONTACT'),
      'src/routes/about.kay': '---\nimport { other } from \'../CONTACT\'\n---\n// CONTACT stays read only\na(href="/CONTACT") It\'s here\np {other}\n',
      'src/CONTACT.ts': 'export const other = \'CONTACT.email = 1\'\n/* CONTACT.email = 2 */\n',
      'src/mention.ts': 'export const label = "CONTACT"\nexport const quoted = \'a "CONTACT" b\'\n',
    }

    expect(await stopOf(files)).toBeUndefined()
  })

  it('is kept through a barrel and a re-export that nothing writes to', async () => {
    const files = {
      'src/content.ts': CONTACT,
      'src/barrel.ts': 'export * from \'./content\'\n',
      'src/routes/index.kay': '---\nimport { CONTACT } from \'../barrel\'\n---\np {CONTACT.email}\n',
    }

    expect(await stopOf(files)).toBeUndefined()
  })

  it('stops when a module writes to it, in a page it does not import', async () => {
    const writes: Record<string, readonly [string, string]> = {
      set: [CONTACT, 'CONTACT.email = \'x\''],
      nestedSet: [CONTACT, 'CONTACT.address.city = \'x\''],
      compound: [CONTACT, 'CONTACT.phone += \'1\''],
      increment: ['export const CONTACT = { email: \'a\', count: 1 }\n', 'CONTACT.count++'],
      prefix: ['export const CONTACT = { email: \'a\', count: 1 }\n', '--CONTACT.count'],
      optionalSet: [CONTACT, 'CONTACT.address.city ||= \'x\''],
      indexSet: [LIST, 'LIST[0] = \'x\''],
      stringKey: [CONTACT, 'CONTACT[\'email\'] = \'x\''],
      push: [LIST, 'LIST.push(\'c\')'],
      splice: [LIST, 'LIST.splice(0, 1)'],
      sort: [LIST, 'LIST.sort()'],
      length: [LIST, 'LIST.length = 0'],
      remove: [CONTACT, 'delete CONTACT.email'],
      assign: [CONTACT, 'Object.assign(CONTACT, { email: \'x\' })'],
      define: [CONTACT, 'Object.defineProperty(CONTACT, \'email\', { value: \'x\' })'],
      prototype: [CONTACT, 'CONTACT.__proto__.polluted = 1'],
      viaConstructor: [CONTACT, 'CONTACT.constructor.prototype.polluted = 1'],
      alias: [CONTACT, 'const alias = CONTACT\nalias.email = \'x\''],
      passed: [CONTACT, 'mutate(CONTACT)'],
      returned: [CONTACT, 'const get = () => CONTACT'],
      nestedAlias: [CONTACT, 'const { address } = CONTACT\naddress.city = \'x\''],
      arrayTarget: [CONTACT, '[CONTACT.email] = [\'x\']'],
      objectTarget: [CONTACT, '({ a: CONTACT.email } = { a: \'x\' })'],
      loopTarget: [CONTACT, 'for (CONTACT.email of [\'x\']) {}'],
      defaultExport: [CONTACT, 'export default CONTACT'],
      renamedExport: [CONTACT, 'export { CONTACT as renamed }'],
      shorthand: [CONTACT, 'export const holder = { CONTACT }'],
      throughNamespace: [CONTACT, 'import * as content from \'./content\'\ncontent.CONTACT.email = \'x\''],
      computedNamespace: [CONTACT, 'import * as content from \'./content\'\nconst key = \'CONTACT\'\ncontent[key].email = \'x\''],
      bareNamespace: [CONTACT, 'import * as content from \'./content\'\nmutate(content)'],
      dynamic: [CONTACT, 'const content = await import(\'./content\')\nconst key = \'CONTACT\'\ncontent[key].email = \'x\''],
      dynamicPath: [CONTACT, 'const content = await import(path)\ncontent.CONTACT.email = \'x\''],
      required: [CONTACT, 'const content = require(\'./content\')\ncontent[\'CONTACT\'].email = \'x\''],
      renamedImport: [CONTACT, 'import { CONTACT as C } from \'./content\'\nC.email = \'x\''],
      evaluated: [CONTACT, 'eval(\'CONTACT.email = 1\')'],
      reexportRenamed: [CONTACT, 'export { CONTACT as C } from \'./content\''],
    }

    for (const [key, [content, write]] of Object.entries(writes)) {
      const name = write.includes('LIST') && !write.includes('CONTACT') ? 'LIST' : 'CONTACT'

      const files = {
        'src/content.ts': content,
        'src/writer.ts': `${write.startsWith('import') || write.startsWith('export') ? '' : 'import { CONTACT, LIST } from \'./content\'\n'}${write}\n`,
        'src/routes/index.kay': PAGE(name, name === 'LIST' ? 'LIST.length' : 'CONTACT.email'),
      }

      expect([key, await stopOf(files)]).toEqual([key, expect.stringContaining('module state')])
    }
  })

  it('stops when the writer is in the exporting module, a .kay script fence, a barrel or a layout', async () => {
    const page = PAGE('CONTACT')

    const cases: Record<string, Record<string, string>> = {
      sameModule: { 'src/content.ts': `${CONTACT}export function update(email: string): void {\n  CONTACT.email = email\n}\n` },
      scriptFence: { 'src/content.ts': CONTACT, 'src/routes/admin.kay': '---\nimport { CONTACT } from \'../content\'\n\nCONTACT.email = \'x\'\n---\np Admin\n' },
      serverFence: { 'src/content.ts': CONTACT, 'src/routes/admin.kay': '--- server\nimport { CONTACT } from \'../content\'\n\nexport const action = () => {\n  CONTACT.email = \'x\'\n}\n---\np Admin\n' },
      throughBarrel: { 'src/content.ts': CONTACT, 'src/barrel.ts': 'export * from \'./content\'\n', 'src/writer.ts': 'import { CONTACT } from \'./barrel\'\n\nCONTACT.email = \'x\'\n' },
      throughNamedBarrel: { 'src/content.ts': CONTACT, 'src/barrel.ts': 'export { CONTACT } from \'./content\'\n', 'src/writer.ts': 'import { CONTACT } from \'./barrel\'\n\nCONTACT.address.city = \'x\'\n' },
      inApi: { 'src/content.ts': CONTACT, 'src/routes/api/contact.ts': 'import { CONTACT } from \'../../content\'\n\nexport const POST = ({ body }: { body: { email: string } }) => {\n  CONTACT.email = body.email\n}\n' },
      inConfig: { 'src/content.ts': CONTACT, 'kay.config.ts': `${CONFIG}\nimport { CONTACT } from './src/content'\n\nCONTACT.email = 'x'\n` },
      nestedCallback: { 'src/content.ts': 'export const CONTACT = { email: \'a\', links: [{ href: \'/\' }] }\n', 'src/writer.ts': 'import { CONTACT } from \'./content\'\n\nCONTACT.links.forEach((link) => { link.href = \'x\' })\n' },
      aliasedBarrel: { 'src/content.ts': CONTACT, 'src/barrel.ts': 'export { CONTACT as C } from \'./content\'\n' },
    }

    for (const [key, files] of Object.entries(cases))
      expect([key, await stopOf({ 'src/routes/index.kay': page, ...files })]).toEqual([key, expect.stringContaining('module state')])
  })

  it('is kept for a nested literal only measured or turned into a string, and stops when it is handed out, since the callee may write to it', async () => {
    const content = 'export const NAV = [{ href: \'/\', label: \'Home\' }]\nexport const SITE = { links: [\'a\'], social: { x: \'y\' } }\n'

    const uses = [
      ['NAV', 'NAV.map(link => link.href).join()'],
      ['NAV', 'NAV.length'],
      ['NAV', '[...NAV].length'],
      ['SITE', 'SITE.social'],
      ['SITE', 'JSON.stringify(SITE)'],
    ] as const

    const kept = []

    for (const [name, use] of uses)
      kept.push([use, await stopOf({ 'src/content.ts': content, 'src/routes/index.kay': PAGE(name, use) })])

    expect(kept).toEqual([
      ['NAV.map(link => link.href).join()', expect.stringContaining('module state')],
      ['NAV.length', undefined],
      ['[...NAV].length', expect.stringContaining('module state')],
      ['SITE.social', expect.stringContaining('module state')],
      ['JSON.stringify(SITE)', undefined],
    ])
  })

  it('stops for what is not a literal, a let, a computed or spread entry, and a call or new', async () => {
    const contents: Record<string, string> = {
      call: 'export const CONTACT = { email: String(1) }\n',
      identifier: 'const email = \'a\'\nexport const CONTACT = { email }\n',
      spread: 'const base = { a: \'1\' }\nexport const CONTACT = { ...base }\n',
      computed: 'const key = \'a\'\nexport const CONTACT = { [key]: \'1\' }\n',
      method: 'export const CONTACT = { email() { return \'a\' } }\n',
      getter: 'export const CONTACT = { get email() { return \'a\' } }\n',
      proto: 'export const CONTACT = { __proto__: { email: \'a\' } }\n',
      nested: 'export const CONTACT = { list: new Set<string>() }\n',
      template: 'const a = \'b\'\nexport const CONTACT = { email: `${a}` }\n',
      map: 'export const CONTACT = new Map<string, string>()\n',
      let: 'export let CONTACT = { email: \'a\' }\n',
      cast: 'export const CONTACT = { email: \'a\' } as Record<string, string> || other\n',
      ternary: 'export const CONTACT = { email: \'a\' } as X ? other : second\n',
      frozenArray: 'export const CONTACT = [\'a\'].concat(other)\n',
    }

    for (const [key, content] of Object.entries(contents)) {
      const files = { 'src/content.ts': content, 'src/routes/index.kay': PAGE('CONTACT') }

      expect([key, await stopOf(files)]).toEqual([key, expect.stringContaining('module state')])
    }
  })

  it('is not decided without the project root, since a writer cannot be ruled out', async () => {
    const root = await project({ 'src/content.ts': CONTACT, 'src/routes/index.kay': PAGE('CONTACT') })
    const { stop } = await keptScan({ file: join(root, 'src/routes/index.kay'), layouts: [] })

    expect(stop?.why).toContain('module state')
  })

  it('prerenders pages reading a plain literal module, and none once a route writes to it', async () => {
    const files = {
      'src/content.ts': 'export const CONTACT = { email: \'contact@example.fr\', phone: \'01\' }\n',
      'src/routes/index.kay': PAGE('CONTACT'),
      'src/routes/other.kay': PAGE('CONTACT'),
    }

    const written = { ...files, 'src/routes/admin.kay': '---\nimport { CONTACT } from \'../content\'\n\nCONTACT.email = \'changed\'\n---\np Admin\n' }

    expect(await built(await project(files))).toEqual(['/', '/other'])
    expect(await built(await project(written))).toEqual([])
  }, 120_000)
})
