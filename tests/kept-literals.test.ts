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
const ICON = 'export function icon(): void {}\n'
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
      'src/routes/index.kay': '---\nimport { CONTACT, FLAT, LIST } from \'../content\'\nimport type { Contact } from \'../content\'\n\nconst { email, phone } = FLAT\nconst copy = { ...CONTACT.address }\nconst more = [...LIST, \'c\']\nconst joined = LIST.join(\', \')\n---\nul\n  for (const item of LIST)\n    li {item}\np {email}{phone}{copy.city}{more.length}{joined}{Object.entries(CONTACT.address).length}{`${LIST[0]}`}{JSON.stringify(LIST)}\n',
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
      callbackArray: [LIST, 'LIST.forEach((item, index, all) => { all.push(item) })'],
      callbackNested: ['export const CONTACT = { tags: [\'a\'] }\n', 'CONTACT.tags.map((tag, index, all) => all.pop())'],
      parenthesised: [CONTACT, '(CONTACT.email) = \'x\''],
      nonNull: [CONTACT, 'CONTACT.address.city! = \'x\''],
      cast: [CONTACT, '(CONTACT.email as any) = \'x\''],
      angleCast: [CONTACT, '(<any>CONTACT.email) = \'x\''],
      loopArrayTarget: [CONTACT, 'for ([CONTACT.email] of [[\'x\']]) {}'],
      loopObjectTarget: [CONTACT, 'for ({ a: CONTACT.email } of [{ a: \'x\' }]) {}'],
      regexQuote: [LIST, 'const quote = /"/; LIST.push("x")'],
      regexApostrophe: [LIST, 'const quote = /\'/g; LIST.push(\'x\')'],
      lookalikeDestructuring: [LIST, 'const [first] = other()\nregistry[id] = LIST\nregistry[id].push(1)'],
      exportedNamespace: [CONTACT, 'export * as content from \'./content\''],
      quotedSpecifier: [CONTACT, 'import { \'CONTACT\' as C } from \'./content\'\nC.email = \'x\''],
      taggedTemplate: [LIST, 'html`${LIST}`'],
      templateHole: [LIST, 'const text = `${LIST}`'],
      indirectEval: [LIST, '(0, eval)(\'LIST.push(1)\')'],
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
      ['NAV.map(link => link.href).join()', undefined],
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

  it('stops when the exporting module lies outside the project, as a write in it is not read', async () => {
    const outer = await project({ 'shared/content.ts': 'export const CONTACT = { email: \'a\' }\nexport function bump(): void {\n  CONTACT.email = \'x\'\n}\n', 'app/kay.config.ts': CONFIG, 'app/src/routes/index.kay': '---\nimport { CONTACT } from \'../../../shared/content\'\n---\np {CONTACT.email}\n' })
    const root = join(outer, 'app')
    const { stop } = await keptScan({ file: join(root, 'src/routes/index.kay'), layouts: [] }, undefined, root)

    expect(stop?.why).toContain('module state')
  })

  it('is not decided without the project root, since a writer cannot be ruled out', async () => {
    const root = await project({ 'src/content.ts': CONTACT, 'src/routes/index.kay': PAGE('CONTACT') })
    const { stop } = await keptScan({ file: join(root, 'src/routes/index.kay'), layouts: [] })

    expect(stop?.why).toContain('module state')
  })

  it('is kept when a file uses the namespace of another module whole, since that module holds none of the literal', async () => {
    const files = {
      'src/content.ts': CONTACT,
      'src/mail.ts': 'export function send(): void {}\n',
      'src/spy.ts': 'import * as mail from \'./mail\'\n\nmutate(mail)\nexport * as again from \'./mail\'\n',
      'src/routes/index.kay': PAGE('CONTACT'),
    }

    expect(await stopOf(files)).toBeUndefined()
  })

  it('stops when a namespace used whole is of a module that holds the literal, re-exports it or cannot be resolved', async () => {
    const cases: Record<string, Record<string, string>> = {
      direct: { 'src/spy.ts': 'import * as content from \'./content\'\n\nmutate(content)\n' },
      barrel: { 'src/barrel.ts': 'export * from \'./content\'\n', 'src/spy.ts': 'import * as barrel from \'./barrel\'\n\nmutate(barrel)\n' },
      namedBarrel: { 'src/barrel.ts': 'export { CONTACT } from \'./content\'\n', 'src/spy.ts': 'import * as barrel from \'./barrel\'\n\nmutate(barrel)\n' },
      missing: { 'src/spy.ts': 'import * as missing from \'./not-there\'\n\nmutate(missing)\n' },
      exported: { 'src/barrel.ts': 'export * as content from \'./content\'\n' },
    }

    for (const [key, files] of Object.entries(cases))
      expect([key, await stopOf({ 'src/content.ts': CONTACT, 'src/routes/index.kay': PAGE('CONTACT'), ...files })]).toEqual([key, expect.stringContaining('module state')])
  })

  it('is kept when only a test file writes to it, as a test runs in a process of its own', async () => {
    const files = {
      'src/content.ts': CONTACT,
      'tests/content.test.ts': 'import { CONTACT } from \'../src/content\'\n\nCONTACT.email = \'x\'\n',
      'src/other.spec.ts': 'import { CONTACT } from \'./content\'\n\nCONTACT.email = \'y\'\n',
      'src/routes/index.kay': PAGE('CONTACT'),
    }

    expect(await stopOf(files)).toBeUndefined()
  })

  it('is kept for the content module of a real site: icons, sibling exports that are no literal and every way a page reads the literal', async () => {
    const content = [
      'import type { IconProps } from \'kay/icons\'',
      'import { brandIcon, carIcon } from \'./icons\'',
      '',
      'export const DEPARTURE = \'2027-01-30\'',
      '',
      'export const CONTACT = {',
      '  association: \'Association d\\\'exemple\',',
      '  street: \'1 rue de l\\\'Exemple\',',
      '  city: \'12345 Exemple\',',
      '  email: \'contact@example.fr\',',
      '  phone: \'01 02 03 04 05\',',
      '  phoneHref: \'+33102030405\',',
      '}',
      '',
      'export const TOPICS = { sponsoring: \'Sponsoring\', autre: \'Autre\' } as const',
      '',
      'export type Topic = keyof typeof TOPICS',
      '',
      'export interface Network { icon: IconProps, label: string, href?: string }',
      '',
      'export const NETWORKS: Network[] = [',
      '  { icon: brandIcon, label: \'Facebook\' },',
      ']',
      '',
      'const SKILLS = [\'a\', \'b\']',
      '',
      'function ratings(values: number[]): number[] {',
      '  return SKILLS.map((_, index) => values[index] ?? 0)',
      '}',
      '',
      'export const CREW = [{ name: \'A\', ratings: ratings([1, 2]) }]',
      '',
      'export const PROGRAMME = [{ title: \'Route\', icon: carIcon }]',
      '',
      'export const BUDGET = [{ label: \'Car\', euros: 2000 }]',
      '',
      'export const BUDGET_TOTAL = BUDGET.reduce((sum, line) => sum + line.euros, 0)',
      '',
    ].join('\n')

    const page = [
      '---',
      'import { CONTACT, TOPICS } from \'../content\'',
      '',
      'const [postalCode, locality] = String(CONTACT.city).split(\' \')',
      'const [zip] = CONTACT.city.split(\' \')',
      'const jsonLd = { \'@type\': \'Organization\', \'name\': CONTACT.association, \'email\': CONTACT.email, \'address\': { \'postalCode\': postalCode, \'addressLocality\': locality } }',
      'const mail = `mailto:${CONTACT.email}`',
      '---',
      'p {CONTACT.association}, {CONTACT.street}',
      'a(href={`mailto:${CONTACT.email}`}) {CONTACT.email}',
      'a(href={`tel:${CONTACT.phoneHref}`}) {CONTACT.phone}',
      'p L\'association répond à toute demande.',
      'p {zip}{mail}{TOPICS.autre}{JSON.stringify(jsonLd)}',
      '',
    ].join('\n')

    const files = {
      'src/content.ts': content,
      'src/mail.ts': 'export function send(): void {}\n',
      'src/icons.ts': 'export function brandIcon(): void {}\nexport function carIcon(): void {}\n',
      'src/routes/index.kay': page,
      'src/routes/legal.kay': PAGE('CONTACT'),
      'tests/contact.test.ts': 'import { expect, it, spyOn } from \'bun:test\'\nimport * as mail from \'../src/mail\'\n\nit(\'sends\', () => {\n  spyOn(mail, \'send\')\n  expect(mail).toBeDefined()\n})\n',
    }

    expect(await stopOf(files, 'src/routes/legal.kay')).toBeUndefined()
    expect(await stopOf(files)).toBeUndefined()
  })

  it('is kept for a computed key read of a container of values, and stops once it is written through one', async () => {
    const topics = 'export const TOPICS = { a: \'A\', b: \'B\' } as const\n'
    const reads = ['TOPICS[topic]', 'TOPICS[props.topic as string].toLowerCase()', 'TOPICS[`${prefix}-a`]']
    const kept = []

    for (const use of reads)
      kept.push(await stopOf({ 'src/content.ts': topics, 'src/routes/index.kay': `---\nimport { TOPICS } from '../content'\n\nconst topic = 'a'\nconst props = { topic }\nconst prefix = 'x'\n---\np {${use}}\n` }))

    expect(kept).toEqual([undefined, undefined, undefined])

    const writes = ['TOPICS[topic] = \'x\'', 'TOPICS[topic].polluted = 1', 'TOPICS[topic]++']

    for (const write of writes)
      expect([write, await stopOf({ 'src/content.ts': topics, 'src/writer.ts': `import { TOPICS } from './content'\n\nconst topic = 'a'\n${write}\n`, 'src/routes/index.kay': PAGE('TOPICS', 'TOPICS.a') })]).toEqual([write, expect.stringContaining('module state')])
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

describe('a page importing a module that exports a container nothing proves unchanged', () => {
  const NETWORKS = 'import { icon } from \'./icon\'\n\nexport const NETWORKS = [{ icon: icon(), label: \'Facebook\' }]\n'

  const content = (more = ''): string => `${NETWORKS}${CONTACT}export function networkLabels(): string[] {\n  return NETWORKS.map(network => network.label)\n}\n\nexport const COUNT = NETWORKS.length + 1\n${more}`

  it('is kept while it imports none of them, nor anything built from them', async () => {
    const files = { 'src/icon.ts': ICON, 'src/content.ts': content(), 'src/routes/index.kay': PAGE('CONTACT') }

    expect(await stopOf(files)).toBeUndefined()
  })

  it('stops once it imports one, a function reading one, a value computed from one, or the whole module', async () => {
    const pages: Record<string, string> = {
      direct: '---\nimport { NETWORKS } from \'../content\'\n---\np {NETWORKS.length}\n',
      renamed: '---\nimport { NETWORKS as networks } from \'../content\'\n---\np {networks.length}\n',
      reader: '---\nimport { networkLabels } from \'../content\'\n---\np {networkLabels().length}\n',
      computed: '---\nimport { COUNT } from \'../content\'\n---\np {COUNT}\n',
      namespace: '---\nimport * as content from \'../content\'\n---\np {content.CONTACT.email}\n',
      throughBarrel: '---\nimport { NETWORKS } from \'../barrel\'\n---\np {NETWORKS.length}\n',
      throughStar: '---\nimport { CONTACT } from \'../star\'\n---\np {CONTACT.email}\n',
    }

    for (const [key, page] of Object.entries(pages)) {
      const files = { 'src/icon.ts': ICON, 'src/content.ts': content(), 'src/barrel.ts': 'export { NETWORKS } from \'./content\'\n', 'src/star.ts': 'export * from \'./content\'\n', 'src/routes/index.kay': page }

      expect([key, await stopOf(files)]).toEqual([key, expect.stringContaining('module state')])
    }
  })

  it('stops for a module that hands one out under another name, as a default or through a helper it keeps to itself', async () => {
    const contents: Record<string, [string, string]> = {
      aliased: [`${NETWORKS}${CONTACT}export { NETWORKS as LINKS }\n`, 'LINKS'],
      defaulted: [`${NETWORKS}${CONTACT}export default NETWORKS\n`, 'default'],
      helper: [`${NETWORKS}${CONTACT}const labels = (): string[] => NETWORKS.map(network => network.label)\nexport const first = (): string | undefined => labels()[0]\n`, 'first'],
    }

    for (const [key, [source, name]] of Object.entries(contents)) {
      const page = name === 'default' ? '---\nimport networks from \'../content\'\n---\np {networks.length}\n' : `---\nimport { ${name} } from '../content'\n---\np {${name}}\n`

      expect([key, await stopOf({ 'src/icon.ts': ICON, 'src/content.ts': source, 'src/routes/index.kay': page })]).toEqual([key, expect.stringContaining('module state')])
      expect([key, await stopOf({ 'src/icon.ts': ICON, 'src/content.ts': source, 'src/routes/index.kay': PAGE('CONTACT') })]).toEqual([key, undefined])
    }
  })

  it('stops whatever it imports for a let or an empty container the module fills', async () => {
    for (const state of ['export let counter = 0\n', 'const cache = new Map<string, string>()\nexport function remember(): void {}\n'])
      expect(await stopOf({ 'src/icon.ts': ICON, 'src/content.ts': `${content()}${state}`, 'src/routes/index.kay': PAGE('CONTACT') })).toEqual(expect.stringContaining('module state'))
  })
})

describe('a page reading the items of an exported array of objects', () => {
  const NAV = 'import { icon } from \'./icon\'\n\nexport const NAV = [{ id: \'a\', label: \'A\', icon, tags: [\'x\'] }, { id: \'b\', label: \'B\', icon, tags: [] }]\nexport const GRID = [{ cells: [{ n: 1 }, { n: 2 }] }]\n'
  const ICON = 'export function icon(): void {}\n'

  const page = (fence: string, template = 'p'): string => `---\nimport { GRID, NAV } from '../content'\n\n${fence}\n---\n${template}\n`

  const stopOfPage = async (fence: string, template?: string): Promise<string | undefined> => stopOf({ 'src/icon.ts': ICON, 'src/content.ts': NAV, 'src/routes/index.kay': page(fence, template) })

  it('is kept while a loop or a callback only reads each item', async () => {
    const reads: [string, string?][] = [
      ['', 'ul\n  for link, index of NAV key={link.id}\n    li(data-icon={link.icon}) {link.label}{index}\n    if link.id === \'a\'\n      span {link.tags.length}'],
      ['', 'for row of GRID\n  for cell of row.cells key={cell.n}\n    p {cell.n}'],
      ['for (const link of NAV) {\n  console.log(link.id, link.label)\n}'],
      ['const ids = NAV.map(link => link.id)\nconst total = NAV.reduce((sum, link) => sum + link.tags.length, 0)'],
      ['const ids = NAV.map((link, index): string => `${link.id}${index}`)\nconst some = NAV.some(link => link.label === \'A\')'],
      ['const out: string[] = []\nNAV.forEach((link) => {\n  out.push(link.id)\n})'],
    ]

    for (const [fence, template] of reads)
      expect([fence, template, await stopOfPage(fence, template)]).toEqual([fence, template, undefined])
  })

  it('stops once a loop or a callback writes to an item, hands it out, copies it or reaches the array itself', async () => {
    const stops: [string, string?][] = [
      ['', 'for link of NAV\n  p {link.id = \'x\'}'],
      ['', 'for link of NAV\n  p {link.tags.push(\'x\')}'],
      ['', 'for link of NAV\n  p {track(link)}'],
      ['', 'for link of NAV\n  p {link.tags.sort()}'],
      ['for (const link of NAV) {\n  link.label = \'x\'\n}'],
      ['for (const link of NAV)\n  keep(link)'],
      ['for (const link of NAV) {\n  const copy = link\n  copy.id = \'x\'\n}'],
      ['NAV.forEach((link) => { link.id = \'x\' })'],
      ['NAV.forEach((link, index, all) => { all.pop() })'],
      ['const same = NAV.map(link => link)'],
      ['const found = NAV.find(link => link.id === \'a\')'],
      ['const some = NAV.filter(link => link.id === \'a\')'],
      ['NAV.sort((a, b) => a.id.localeCompare(b.id))'],
      ['NAV.map(link => link.id, NAV)'],
      ['NAV.map(function (link) { return link.id })'],
      ['const rows = GRID.map(row => row.cells)'],
      ['for (const link of NAV)\n  console.log(link.id)'],
      ['const m = \'push\'\n;(NAV as any)[m]({})'],
      ['const m = \'sort\'\nNAV[m]()'],
      ['NAV.reduce((acc, link) => { acc.n += 1; return acc })'],
      ['NAV.reduce(acc => acc)'],
      ['const leak: unknown[] = []\nfor (const link of NAV) if (link.id)\n  leak.push(link)'],
    ]

    for (const [fence, template] of stops)
      expect([fence, template, await stopOfPage(fence, template)]).toEqual([fence, template, expect.stringContaining('module state')])
  })
})

describe('a constant exported by name after its declaration', () => {
  const CONTENT = 'const CONTACT = { email: \'a@b.fr\', phone: \'01\' }\n'

  it('is kept while nothing writes to it, and stops once a module or its own does', async () => {
    const kept = { 'src/content.ts': `${CONTENT}export { CONTACT }\n`, 'src/routes/index.kay': PAGE('CONTACT') }
    const early = { 'src/content.ts': `export { CONTACT }\n${CONTENT}`, 'src/routes/index.kay': PAGE('CONTACT') }

    expect(await stopOf(kept)).toBeUndefined()
    expect(await stopOf(early)).toBeUndefined()

    const writers: Record<string, Record<string, string>> = {
      module: { 'src/writer.ts': 'import { CONTACT } from \'./content\'\n\nCONTACT.email = \'x\'\n' },
      own: { 'src/content.ts': `${CONTENT}export { CONTACT }\nCONTACT.email = 'x'\n` },
      early: { 'src/content.ts': `export { CONTACT }\n${CONTENT}`, 'src/writer.ts': 'import { CONTACT } from \'./content\'\n\nCONTACT.email = \'x\'\n' },
      push: { 'src/content.ts': 'const LIST = [\'a\']\nexport { LIST }\n', 'src/writer.ts': 'import { LIST } from \'./content\'\n\nLIST.push(\'b\')\n', 'src/routes/index.kay': PAGE('LIST', 'LIST.length') },
    }

    for (const [key, files] of Object.entries(writers))
      expect([key, await stopOf({ ...kept, ...files })]).toEqual([key, expect.stringContaining('module state')])
  })

  it('stops under another name or as the default, which no importer is followed through, and not for what no page takes', async () => {
    const pages: Record<string, [string, string]> = {
      renamed: ['export { CONTACT as INFO }\n', '---\nimport { INFO } from \'../content\'\n---\np {INFO.email}\n'],
      default: ['export default CONTACT\n', '---\nimport info from \'../content\'\n---\np {info.email}\n'],
      asDefault: ['export { CONTACT as default }\n', '---\nimport info from \'../content\'\n---\np {info.email}\n'],
    }

    for (const [key, [exported, page]] of Object.entries(pages))
      expect([key, await stopOf({ 'src/content.ts': `${CONTENT}${exported}`, 'src/routes/index.kay': page })]).toEqual([key, expect.stringContaining('module state')])

    const untaken = { 'src/content.ts': `${CONTENT}${LIST}export default CONTACT\nexport { CONTACT as INFO }\n`, 'src/routes/index.kay': PAGE('LIST', 'LIST.length') }

    expect(await stopOf(untaken)).toBeUndefined()
  })
})

describe('an import list with comments', () => {
  it('still names what the page takes', async () => {
    const files = {
      'src/content.ts': 'export const CONTACT = { email: \'a\' }\nexport const cache = new Map<string, string>()\nexport function put(): void {\n  cache.set(\'a\', \'b\')\n}\n',
      'src/routes/index.kay': '---\nimport {\n  CONTACT, // phone\n  put,\n} from \'../content\'\n---\np {CONTACT.email}{put}\n',
    }

    expect(await stopOf(files)).toEqual(expect.stringContaining('module state'))
  })
})
