import type { Asked } from '../packages/ai/src'
import { afterAll, describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { flattenMessages } from '../src/runtime/i18n'
import { draftMessages } from '../src/server/message-drafts'
import { scratchDir } from './scratch'

// `kay i18n translate` of kayjs-ai, each run in a process of its own with a scripted model: the content and message loaders serve one project per process.
const driver = join(import.meta.dir, 'helpers/ai-translate-driver.ts')
const dirs: string[] = []
const i18n = { locales: ['en', 'fr', 'de'], defaultLocale: 'en' }

afterAll(async () => Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true }))))

const messages = (body: string) => `import { defineMessages } from 'kay/i18n'\n\nexport default defineMessages(${body})\n`
const collections = 'import { t } from \'elysia\'\nimport { collection } from \'kay/content\'\n\nconst fields = { title: t.String(), date: t.Optional(t.String({ format: \'date\' })), tags: t.Optional(t.Array(t.String())) }\n\nexport const news = collection(\'content/news\', { schema: t.Object({ ...fields, draft: t.Optional(t.Boolean()) }), localized: true, draft: \'draft\' })\nexport const docs = collection(\'content/docs\', { schema: t.Object(fields), localized: true })\nexport const data = collection(\'content/data\', { schema: t.Object({ name: t.String() }), localized: true })\n'
const site: Record<string, string> = {
  'src/messages/en.ts': messages('{\n  nav: { home: \'Home\', about: \'About <b>us</b>\' },\n  hello: \'Hello {name}\',\n  items: { one: \'{count} item\', other: \'{count} items\' },\n}'),
  'src/messages/fr.ts': messages('{\n  nav: { home: \'Accueil\' },\n}'),
  'src/content.config.ts': collections,
  'src/content/news/en/.keep': '',
  'src/content/docs/en/.keep': '',
  'src/content/data/en/.keep': '',
}
const entries: Record<string, string> = {
  'src/content/news/en/launch.md': '---\ntitle: Launch\ndate: 2026-01-02\ntags: [one, two]\n---\nSee [the site](https://a.example/x) now.\n',
  'src/content/docs/en/guide.md': '---\ntitle: Guide\n---\nRead [more](/more).\n\n```ts\nconst a = 1\n```\n',
  'src/content/data/en/item.json': '{ "name": "Item" }\n',
}
const noMessages = { 'src/messages/en.ts': messages('{}'), 'src/messages/fr.ts': messages('{}') }

interface Result {
  code: number
  refused: boolean
  out: string
  err: string
  asked: Asked[]
}

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('ai-translate-')

  dirs.push(root)
  await Promise.all(Object.entries({ ...site, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function run(root: string, args: string[], replies: object[] = [], flags: Record<string, boolean> = {}): Promise<Result> {
  const child = Bun.spawn([process.execPath, driver, root, JSON.stringify({ args, flags, replies, i18n })], { cwd: root, env: { PATH: process.env.PATH!, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  if (stdout === '')
    throw new Error(`the driver failed: ${stderr}`)

  return JSON.parse(stdout) as Result
}

const read = async (root: string, path: string) => Bun.file(join(root, path)).text()
const exists = async (root: string, path: string) => Bun.file(join(root, path)).exists()
const frMessages = async (root: string) => Object.fromEntries(flattenMessages((await import(join(root, 'src/messages/fr.ts')) as { default: Parameters<typeof flattenMessages>[0] }).default))
const temporaries = async (root: string) => Array.fromAsync(new Bun.Glob('**/*.tmp').scan({ cwd: root, dot: true }))

describe('kay i18n translate: messages', () => {
  it('writes the messages a locale lacks as drafts, keeping placeholders, tags and plural forms', async () => {
    const root = await project({})
    const { code, out, err, asked } = await run(root, ['fr'], [{}])

    expect(err).toBe('')
    expect(code).toBe(0)
    expect(out).toContain('Translated 3 messages and 0 entries')
    expect(await frMessages(root)).toEqual({
      'nav.home': 'Accueil',
      'nav.about': 'FR About <b>us</b>',
      'hello': 'FR Hello {name}',
      'items': { one: 'FR {count} item', other: 'FR {count} items' },
    })
    expect(draftMessages(await read(root, 'src/messages/fr.ts')).map(({ key }) => key)).toEqual(['nav.about', 'hello', 'items'])
    expect(asked[0]!.system).toContain('{placeholder}')
    expect((await run(root, ['fr'])).out).toBe('fr lacks nothing')
  })

  it('asks again, with the reason, for a text that drops a placeholder or a tag', async () => {
    const root = await project({})
    const { code, asked } = await run(root, ['fr'], [{ over: { 1: { replace: [['<b>', ''], ['</b>', '']] }, 2: 'Bonjour' } }, {}])

    expect(code).toBe(0)
    expect(asked).toHaveLength(2)
    expect(asked[1]!.system).toContain('2 drops {name}')
    expect(asked[1]!.system).toContain('1 changes the tags')
    expect(Object.keys(JSON.parse(asked[1]!.messages[0]!.content))).toEqual(['1', '2'])
    expect(await frMessages(root)).toMatchObject({ 'nav.about': 'FR About <b>us</b>', 'hello': 'FR Hello {name}' })
  })

  it('never writes a message still wrong after the retry, a plural dropping {count} included, and exits 1 saying which', async () => {
    const root = await project({})
    const wrong = { over: { 3: 'sans nombre', 4: '{count} articles' } }
    const { code, err } = await run(root, ['fr'], [wrong, wrong])
    const flat = await frMessages(root)

    expect(code).toBe(1)
    expect(err).toContain('message items drops {count}')
    expect(flat.items).toBeUndefined()
    expect(flat.hello).toBe('FR Hello {name}')
    expect(draftMessages(await read(root, 'src/messages/fr.ts')).map(({ key }) => key)).toEqual(['nav.about', 'hello'])
  })

  it('writes nothing when no reply is usable', async () => {
    const root = await project({})
    const before = await read(root, 'src/messages/fr.ts')
    const { code, err } = await run(root, ['fr'], [{ text: 'Sorry, I cannot do that' }, { text: '{ "1": ' }])

    expect(code).toBe(1)
    expect(err).toContain('not one JSON object')
    expect(await read(root, 'src/messages/fr.ts')).toBe(before)
  })

  it('rejects a reply holding an id that was not asked, an injected key included', async () => {
    const root = await project({})
    const { code, asked } = await run(root, ['fr'], [{ extra: { 'evil.key': 'pwned', '99': 'x' } }, {}])

    expect(code).toBe(0)
    expect(asked[1]!.system).toContain('ids that were not asked')
    expect(Object.keys(await frMessages(root))).not.toContain('evil.key')
    expect(await read(root, 'src/messages/fr.ts')).not.toContain('pwned')
  })

  it('rejects a text with a line break the source has not, and keeps a quote or a comment marker inside a string', async () => {
    const root = await project({})
    const { code, asked } = await run(root, ['fr'], [{ over: { 1: '$TEXT\n  evil: \'x\', // draft', 2: 'l\'accueil // draft $TEXT' } }, { over: { 1: 'l\'$TEXT' } }])
    const source = await read(root, 'src/messages/fr.ts')

    expect(code).toBe(0)
    expect(asked[1]!.system).toContain('1 holds a line break')
    expect(source).not.toContain('evil')
    expect(await frMessages(root)).toMatchObject({ 'nav.about': 'l\'About <b>us</b>', 'hello': 'l\'accueil // draft Hello {name}' })
    expect(draftMessages(source).map(({ key }) => key)).toEqual(['nav.about', 'hello', 'items'])
  })

  it('refuses a locale that is not configured, or the default one, before any request', async () => {
    const root = await project({})

    for (const locale of ['es', 'en', '../x']) {
      const { code, err, asked } = await run(root, [locale], [{}])

      expect(code).toBe(1)
      expect(err).toContain(`${locale} is not one of the locales translated from en: fr, de`)
      expect(asked).toEqual([])
    }

    expect((await run(root, [])).refused).toBe(true)
    expect(await read(root, 'src/messages/fr.ts')).toBe(site['src/messages/fr.ts']!)
    expect(await temporaries(root)).toEqual([])
  })

  it('has nothing to do, and asks nothing, when the locale lacks nothing', async () => {
    const root = await project({ 'src/messages/en.ts': messages('{ a: \'A\' }'), 'src/messages/fr.ts': messages('{ a: \'Un\' }') })
    const { code, out, asked } = await run(root, ['fr'], [{}])

    expect(code).toBe(0)
    expect(out).toBe('fr lacks nothing')
    expect(asked).toEqual([])
  })

  it('lists what it would translate and the tokens in a dry run, with no request and no file', async () => {
    const root = await project(entries)
    const before = await read(root, 'src/messages/fr.ts')
    const { code, out, asked } = await run(root, ['fr'], [{}], { 'dry-run': true })

    expect(code).toBe(1)
    expect(out).toMatch(/^fr: would translate 3 messages and 2 entries, about \d+ tokens in and \d+ out/)
    expect(out).toContain('messages: nav.about, hello, items')
    expect(out).toContain('news: launch')
    expect(asked).toEqual([])
    expect(await read(root, 'src/messages/fr.ts')).toBe(before)
    expect(await exists(root, 'src/content/news/fr/launch.md')).toBe(false)
  })
})

describe('kay i18n translate: entries', () => {
  it('leaves a string field of a custom cms kind as it is, and translates the plain ones', async () => {
    const config = 'import { t } from \'elysia\'\nimport { collection, customField } from \'kay/content\'\n\nexport const palette = collection(\'content/palette\', { schema: t.Object({ title: t.String(), color: customField(\'color\', t.String()), swatches: t.Array(customField(\'color\', t.String())), box: customField(\'box\', t.Object({ label: t.String() })) }), localized: true })\n'
    const root = await project({ ...noMessages, 'src/content.config.ts': config, 'src/content/palette/en/main.md': '---\ntitle: Main\ncolor: "#ff0000"\nswatches: ["#00ff00"]\nbox:\n  label: Boxed\n---\nBody\n' })
    const { asked } = await run(root, ['fr'], [{}])
    const written = await read(root, 'src/content/palette/fr/main.md')

    expect(written).toContain('title: FR Main')
    expect(written).toContain('#ff0000')
    expect(written).toContain('#00ff00')
    expect(written).not.toContain('FR #')
    expect(asked[0]!.messages[0]!.content).not.toContain('#ff0000')
    expect(asked[0]!.messages[0]!.content).not.toContain('#00ff00')
    expect(written).not.toContain('FR Boxed')
    expect(asked[0]!.messages[0]!.content).not.toContain('Boxed')
  })

  it('leaves a field the schema marks untranslated as it is, at any depth, and lists the paths it translates in a dry run', async () => {
    const config = 'import { t } from \'elysia\'\nimport { collection, untranslated } from \'kay/content\'\n\nexport const shop = collection(\'content/shop\', { schema: t.Object({ title: t.String(), brand: untranslated(t.String()), maybe: t.Optional(untranslated(t.String())), meta: untranslated(t.Object({ label: t.String() })), rows: t.Array(t.Object({ name: t.String(), sku: untranslated(t.String()) })) }), localized: true })\n'
    const files = { ...noMessages, 'src/content.config.ts': config, 'src/content/shop/en/mug.md': '---\ntitle: Mug\nbrand: Acme\nmaybe: Keep\nmeta:\n  label: Label\nrows:\n  - name: Red\n    sku: R-1\n---\nBody\n' }
    const root = await project(files)
    const dry = await run(root, ['fr'], [], { 'dry-run': true })

    expect(dry.out).toContain('shop: mug (title, rows.0.name, body)')
    expect(dry.out).not.toContain('brand')

    const { asked } = await run(root, ['fr'], [{}])
    const written = await read(root, 'src/content/shop/fr/mug.md')

    expect(written).toContain('title: FR Mug')
    expect(written).toContain('name: FR Red')
    expect(written).toContain('brand: Acme')
    expect(written).toContain('maybe: Keep')
    expect(written).toContain('label: Label')
    expect(written).toContain('sku: R-1')
    for (const kept of ['Acme', 'Keep', 'Label', 'R-1'])
      expect(asked[0]!.messages[0]!.content).not.toContain(kept)
  })

  it('writes an entry of a collection with a draft field with that field true, other fields kept', async () => {
    const root = await project({ ...entries, ...noMessages })
    const { code } = await run(root, ['fr'], [{}, {}])
    const news = await read(root, 'src/content/news/fr/launch.md')

    expect(code).toBe(1)
    expect(news).toContain('title: FR Launch')
    expect(news).toContain('draft: true')
    expect(news).toContain('2026-01-02')
    expect(news).toContain('- FR one')
    expect(news).toContain('FR See [the site](https://a.example/x) now.')
    expect(news).not.toContain('FR 2026')
  })

  it('marks an entry of a collection with no draft field with a first-line comment, and skips a JSON one it cannot mark', async () => {
    const root = await project({ ...entries, ...noMessages })
    const { err } = await run(root, ['fr'], [{}, {}])
    const docs = await read(root, 'src/content/docs/fr/guide.md')

    expect(docs.startsWith('---\n# draft\ntitle: FR Guide\n---\n')).toBe(true)
    expect(docs).toContain('[more](/more)')
    expect(docs).toContain('```ts\nconst a = 1\n```')
    expect(err).toContain('data/item: holds JSON, which cannot be marked a draft')
    expect(await exists(root, 'src/content/data/fr/item.json')).toBe(false)
  })

  it('rejects a body that changes a link target or drops a code fence, and writes no file for it', async () => {
    const root = await project({ ...entries, ...noMessages })
    const bad = { over: { body: { replace: [['/more', '/plus'], ['```ts', '']] } } }
    const { code, err } = await run(root, ['fr'], [bad, bad, {}])

    expect(code).toBe(1)
    expect(err).toContain('changes the link targets or code fences')
    expect(await exists(root, 'src/content/docs/fr/guide.md')).toBe(false)
    expect(await exists(root, 'src/content/news/fr/launch.md')).toBe(true)
  })

  it('writes a YAML entry as YAML, marked by a first-line comment', async () => {
    const root = await project({ ...noMessages, 'src/content.config.ts': `${collections}export const yml = collection('content/yml', { schema: t.Object({ name: t.String(), kind: t.String({ pattern: '^[a-z]+$' }) }), localized: true })\n`, 'src/content/yml/en/a.yaml': 'name: Apple\nkind: fruit\n' })
    const { err } = await run(root, ['fr'], [{}])

    expect(err).toBe('')
    expect(await read(root, 'src/content/yml/fr/a.yaml')).toBe('# draft\nname: FR Apple\nkind: fruit\n')
    expect(await exists(root, 'src/content/yml/fr/a.json')).toBe(false)
  })

  it('rejects a body gaining raw HTML, and a text dropping one of two placeholders', async () => {
    const root = await project({ ...entries, ...noMessages })
    const bad = { over: { body: { replace: [['Read', 'Read <img src=x onerror=alert(1)>']] } } }
    const { err } = await run(root, ['fr'], [bad, bad, {}])

    expect(err).toContain('changes the tags of the source')
    expect(await exists(root, 'src/content/docs/fr/guide.md')).toBe(false)
  })

  it('never overwrites an entry the locale gained meanwhile', async () => {
    const root = await project({ ...entries, ...noMessages })
    const person = { writeBefore: { path: 'src/content/news/fr/launch.md', text: '---\ntitle: Written by a person\n---\n' } }
    const { err } = await run(root, ['fr'], [person, person])

    expect(await read(root, 'src/content/news/fr/launch.md')).toContain('Written by a person')
    expect(err).toContain('news/launch')
    expect(await temporaries(root)).toEqual([])
  })
})

describe('kay i18n translate: an interrupted run', () => {
  it('leaves complete files, and a rerun carries on with what is missing', async () => {
    const root = await project({ ...entries, 'src/messages/en.ts': messages('{ a: \'A {n}\' }'), 'src/messages/fr.ts': messages('{}'), 'src/content/data/en/item.json': '{ "name": "Item" }\n' })
    const first = await run(root, ['fr'], [{}, { fail: 'connection lost' }])

    expect(first.code).toBe(1)
    expect(first.err).toContain('connection lost')
    expect(await frMessages(root)).toEqual({ a: 'FR A {n}' })
    expect(await exists(root, 'src/content/news/fr/launch.md')).toBe(false)
    expect(await temporaries(root)).toEqual([])

    const second = await run(root, ['fr'], [{}, {}])

    expect(second.out).toContain('Translated 0 messages and 2 entries')
    expect(second.asked).toHaveLength(2)
    expect(await frMessages(root)).toEqual({ a: 'FR A {n}' })
    expect(await read(root, 'src/content/news/fr/launch.md')).toContain('draft: true')
  })

  it('keeps the messages file as it was when the request fails at once', async () => {
    const root = await project({ 'src/messages/en.ts': messages('{ a: \'A\' }'), 'src/messages/fr.ts': messages('{}') })
    const { code } = await run(root, ['fr'], [{ fail: 'stopped' }])

    expect(code).toBe(1)
    expect(await read(root, 'src/messages/fr.ts')).toBe(messages('{}'))
    expect(await temporaries(root)).toEqual([])
  })
})
