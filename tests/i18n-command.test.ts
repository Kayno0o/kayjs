import { rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { messageProblems } from '../src/check/messages'
import { contentChecks, projectProblems } from '../src/check/project'
import { flattenMessages } from '../src/runtime/i18n'
import { acceptDrafts, draftMessages, writeDraftMessages } from '../src/server/message-drafts'
import { missingTranslations } from '../src/server/translations'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '../src/cli.ts')
const dirs: string[] = []
const i18n = { locales: ['en', 'fr', 'de'], defaultLocale: 'en' }

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('i18n-command-')

  dirs.push(root)
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function kay(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: { PATH: process.env.PATH! }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

const messages = (body: string) => `import { defineMessages } from 'kay/i18n'\n\nexport default defineMessages(${body})\n`
const library = {
  'lib/messages/en.ts': messages('{ lib: { hello: \'Hello\', bye: \'Bye\' } }'),
  'lib/messages/fr.ts': messages('{ lib: { hello: \'Bonjour\' } }'),
  'lib/hello.ts': 'export default {\n  usage: \'hello world <who>\',\n  options: { loud: { type: \'boolean\' } },\n  positionals: 1,\n  run: ({ values, positionals: [who] }, refuse, { root, config }) => {\n    if (who === undefined)\n      return refuse(\'hello world needs someone to greet\')\n\n    console.log(JSON.stringify({ who, loud: values.loud === true, root, locales: config.i18n.locales }))\n\n    return 0\n  },\n}\n',
  'lib/translate.ts': 'export default { usage: \'i18n translate <locale>\', options: {}, positionals: 1, run: ({ positionals: [locale] }) => { console.log(`translating ${locale}`); return 0 } }\n',
}
const site = {
  ...library,
  'kay.config.ts': `export default { favicon: false, i18n: ${JSON.stringify(i18n)}, extensions: [{ name: 'kay-lib', messages: './lib/messages', commands: { 'hello world': './lib/hello.ts', 'i18n translate': './lib/translate.ts' } }] }\n`,
  'src/messages/en.ts': messages('{\n  nav: { home: \'Home\', about: \'About\' },\n  items: { one: \'{count} item\', other: \'{count} items\' },\n}'),
  'src/messages/fr.ts': messages('{\n  nav: {\n    home: \'Accueil\',\n    about: \'À propos\', // draft\n  },\n  items: { one: \'{count} article\', other: \'{count} articles\' }, // draft: checked by no one\n  // draft notes about nothing\n}'),
  'src/content.config.ts': 'import { t } from \'elysia\'\nimport { collection } from \'kay/content\'\n\nexport const news = collection(\'content/news\', { schema: t.Object({ title: t.String() }), localized: true })\nexport const pages = collection(\'content/pages\', { schema: t.Object({ title: t.String() }) })\n',
  'src/content/news/en/hello.md': '---\ntitle: Hello\n---\n',
  'src/content/news/en/launch.md': '---\ntitle: Launch\n---\n',
  'src/content/news/fr/hello.md': '---\ntitle: Bonjour\n---\n',
  'src/content/news/fr/only-fr.md': '---\ntitle: Seulement\n---\n',
  'src/content/pages/about.md': '---\ntitle: About\n---\n',
}

describe('draft messages', () => {
  const source = messages('{\n  nav: {\n    home: \'Accueil\',\n    about: \'À propos\', // draft\n    url: \'https://a.example // draft\',\n  },\n  items: { // draft\n    one: \'{count} article\',\n    other: \'{count} articles\',\n  },\n  \'two words\': \'Deux mots\', // draft: model x\n  // draft of a note, on no message\n}')

  it('are the messages whose key line ends on a `// draft` comment, not a string holding the words', () => {
    expect(draftMessages(source)).toEqual([{ key: 'nav.about', line: 6 }, { key: 'items', line: 9 }, { key: 'two words', line: 13 }])
    expect(draftMessages('export default 1')).toEqual([])
    expect(draftMessages('not code {')).toEqual([])
  })

  it('are accepted by deleting their comments alone', () => {
    const { source: accepted, accepted: count } = acceptDrafts(source)

    expect(count).toBe(3)
    expect(draftMessages(accepted)).toEqual([])
    expect(accepted).toContain('    about: \'À propos\',\n')
    expect(accepted).toContain('  items: {\n')
    expect(accepted).toContain('\'https://a.example // draft\'')
    expect(accepted).toContain('// draft of a note, on no message')
  })

  it('share one comment when several messages are on its line, accepted once', () => {
    const grouped = messages('{\n  a: \'A\', b: \'B\', // draft\n  nav: { x: \'X\', y: \'Y\' }, // draft\n}')
    const { source: accepted, accepted: count } = acceptDrafts(grouped)

    expect(draftMessages(grouped).map(({ key }) => key)).toEqual(['a', 'b', 'nav.x', 'nav.y'])
    expect(count).toBe(2)
    expect(accepted).toBe(messages('{\n  a: \'A\', b: \'B\',\n  nav: { x: \'X\', y: \'Y\' },\n}'))
  })

  it('are written into a locale\'s file at their place in the nesting, the rest left as written, and read back as messages', async () => {
    const root = await project({ 'src/messages/fr.ts': messages('{\n  nav: {\n    home: \'Accueil\' // kept\n  },\n  short: { a: \'A\' },\n  // a note\n}') })
    const written = await writeDraftMessages(root, { i18n }, 'fr', { 'nav.about': 'À propos', 'nav.home': 'Maison', 'short.b': 'B', 'deep.er.key': 'Profond', 'items': { one: '{count} article', other: '{count} articles' }, 'it\'s': 'l\'apostrophe\nligne' })
    const file = join(root, 'src/messages/fr.ts')
    const text = await Bun.file(file).text()

    expect(written).toEqual(['nav.about', 'short.b', 'deep.er.key', 'items', 'it\'s'])
    expect(text).toContain('    home: \'Accueil\', // kept\n    about: \'À propos\', // draft\n  },')
    expect(text).toContain('  short: {\n    a: \'A\',\n    b: \'B\', // draft\n  },')
    expect(text).toContain('  // a note\n')
    expect(draftMessages(text).map(({ key }) => key)).toEqual(['nav.about', 'short.b', 'deep.er.key', 'items', 'it\'s'])

    const tree = (await import(file) as { default: Parameters<typeof flattenMessages>[0] }).default

    expect(Object.fromEntries(flattenMessages(tree))).toEqual({ 'nav.home': 'Accueil', 'nav.about': 'À propos', 'short.a': 'A', 'short.b': 'B', 'deep.er.key': 'Profond', 'items': { one: '{count} article', other: '{count} articles' }, 'it\'s': 'l\'apostrophe\nligne' })
  })

  it('create the locale\'s file when it is missing, and the default export of an empty one', async () => {
    const root = await project({ 'src/messages/fr.ts': messages('{}') })

    await writeDraftMessages(root, { i18n }, 'fr', { 'nav.home': 'Accueil' })
    await writeDraftMessages(root, { i18n: { ...i18n, messages: 'lang' } }, 'de', { greeting: 'Hallo' })

    expect(await Bun.file(join(root, 'src/messages/fr.ts')).text()).toBe(messages('{\n  nav: {\n    home: \'Accueil\', // draft\n  },\n}'))
    expect(await Bun.file(join(root, 'lang/de.ts')).text()).toBe(messages('{\n  greeting: \'Hallo\', // draft\n}'))
  })

  it('keep a one-line object\'s comments, the file\'s line breaks and its indent', async () => {
    const root = await project({
      'src/messages/fr.ts': messages('{ /* c */ a: \'A\' /* d */ }'),
      'src/messages/de.ts': messages('{\r\n\tnav: {\r\n\t\thome: \'Start\',\r\n\t},\r\n}').replaceAll('\n', '\r\n').replaceAll('\r\r\n', '\r\n'),
    })

    await writeDraftMessages(root, { i18n }, 'fr', { b: 'B' })
    await writeDraftMessages(root, { i18n }, 'de', { 'nav.about': 'Über', 'deep.key': 'Tief' })

    expect(await Bun.file(join(root, 'src/messages/fr.ts')).text()).toBe(messages('{\n  /* c */ a: \'A\' /* d */,\n  b: \'B\', // draft\n}'))

    const german = await Bun.file(join(root, 'src/messages/de.ts')).text()

    expect(german).toContain('\t\thome: \'Start\',\r\n\t\tabout: \'Über\', // draft\r\n\t},\r\n\tdeep: {\r\n\t\tkey: \'Tief\', // draft\r\n\t},\r\n}')
    expect(german.replaceAll('\r\n', '')).not.toContain('\n')
  })

  it('are written only for a locale i18n translates from the default one', async () => {
    const root = await project({})

    await Promise.all(['../x', 'it', 'en'].map(async locale => expect(writeDraftMessages(root, { i18n }, locale, { a: 'A' })).rejects.toThrow(`was given the locale ${JSON.stringify(locale)}, which is not one of those translated from en: fr, de`)))

    await expect(writeDraftMessages(root, {}, 'fr', { a: 'A' })).rejects.toThrow('kay.config.ts sets no i18n')
    expect(await Array.fromAsync(new Bun.Glob('**/*.ts').scan({ cwd: root, dot: true }))).toEqual([])
  })

  it('are reported by kay check as draft-message, at their line', async () => {
    const root = await project(site)
    const problems = await messageProblems(root, i18n, [{ name: 'kay-lib', messages: './lib/messages' }])

    expect(problems.filter(problem => problem.code === 'draft-message')).toEqual([
      { file: 'src/messages/fr.ts', line: 6, message: 'gives nav.about as a draft, which no one has checked yet', code: 'draft-message' },
      { file: 'src/messages/fr.ts', line: 8, message: 'gives items as a draft, which no one has checked yet', code: 'draft-message' },
    ])

    const extensions = [{ name: 'kay-lib', messages: './lib/messages' }]
    const reported = async (lints?: Record<string, 'allow' | 'warn' | 'deny'>) => (await projectProblems(root, { i18n, extensions, lints }, { problems: [], feeds: [], routes: [], props: new Map() })).filter(problem => problem.code === 'draft-message')

    expect((await reported()).map(({ line, severity, help }) => ({ line, severity, help }))).toEqual([
      { line: 6, severity: 'warning', help: 'check it, then delete its `// draft` comment, or run `kay i18n accept <locale>` for every draft of the locale' },
      { line: 8, severity: 'warning', help: expect.any(String) },
    ])
    expect((await reported({ 'draft-message': 'deny' })).map(({ severity }) => severity)).toEqual(['error', 'error'])
    expect(await reported({ i18n: 'allow' })).toEqual([])
  })
})

describe('draft entries', () => {
  const config = 'import { t } from \'elysia\'\nimport { collection } from \'kay/content\'\n\nconst schema = t.Object({ title: t.String() })\n\nexport const news = collection(\'content/news\', { schema, localized: true })\nexport const notes = collection(\'content/notes\', { schema })\nexport const held = collection(\'content/held\', { schema: t.Object({ title: t.String(), draft: t.Optional(t.Boolean()) }), localized: true, draft: \'draft\' })\n'
  const entries = {
    'kay.config.ts': `export default { favicon: false, i18n: ${JSON.stringify(i18n)} }\n`,
    'src/messages/en.ts': messages('{}'),
    'src/messages/fr.ts': messages('{}'),
    'src/messages/de.ts': messages('{}'),
    'src/content.config.ts': config,
    'src/content/news/en/a.md': '---\ntitle: A\n---\n',
    'src/content/news/fr/a.md': '---\n# draft\ntitle: A fr\n---\nBody\n',
    'src/content/news/fr/crlf.md': '---\r\n# draft\r\ntitle: Crlf\r\n---\r\n',
    'src/content/news/fr/b.yaml': '# draft\ntitle: B fr\n',
    'src/content/news/de/b.yaml': 'title: "# draft"\n',
    'src/content/news/de/c.md': '---\ntitle: C\n---\n# draft\n',
    'src/content/news/de/d.yaml': '# drafted by Ann\ntitle: D\n',
    'src/content/news/de/e.yaml': 'title: E\n# draft\n',
    'src/content/notes/n.yaml': '# draft\ntitle: Not localized\n',
    'src/content/held/fr/h.yaml': '# draft\ntitle: Held\ndraft: true\n',
  }

  it('are reported by kay check as draft-entry, at their line, only in a localized collection', async () => {
    const root = await project(entries)
    const reported = async (lints?: Record<string, 'allow' | 'warn' | 'deny'>) => (await contentChecks(root, { i18n, lints })).problems.filter(problem => problem.code === 'draft-entry')

    expect((await reported()).map(({ file, line, severity }) => ({ file: relative(root, file), line, severity }))).toEqual([
      { file: 'src/content/held/fr/h.yaml', line: 1, severity: 'warning' },
      { file: 'src/content/news/fr/a.md', line: 2, severity: 'warning' },
      { file: 'src/content/news/fr/b.yaml', line: 1, severity: 'warning' },
      { file: 'src/content/news/fr/crlf.md', line: 2, severity: 'warning' },
    ])
    expect((await reported({ 'draft-entry': 'deny' })).map(({ severity }) => severity)).toEqual(['error', 'error', 'error', 'error'])
    expect(await reported({ 'draft-entry': 'allow' })).toEqual([])
  })

  it('are not reported once accepted: the line deleted, or a draft kept by no comment', async () => {
    const root = await project({ ...entries, 'src/content/news/fr/a.md': '---\ntitle: A fr\n---\n', 'src/content/news/fr/b.yaml': 'title: B fr\n', 'src/content/news/fr/crlf.md': '---\ntitle: Crlf\n---\n', 'src/content/held/fr/h.yaml': 'title: Held\n' })

    expect((await contentChecks(root, { i18n })).problems.filter(problem => problem.code === 'draft-entry')).toEqual([])
  })
})

describe('kay i18n', () => {
  it('lists what each locale lacks: messages, its libraries\' included, and localized entries, a draft counting as there', async () => {
    const root = await project(site)
    const { stdout, stderr, code } = await kay(['i18n', 'missing', '--format', 'json'], root)

    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      locales: {
        fr: { messages: ['lib.bye'], entries: { news: ['launch'] } },
        de: { messages: ['lib.hello', 'lib.bye', 'nav.home', 'nav.about', 'items'], entries: { news: ['hello', 'launch'] } },
      },
    })

    const text = await kay(['i18n', 'missing', 'fr'], root)

    expect(text.stdout).toBe('fr lacks 1 message: lib.bye\nfr lacks 1 entry of news: launch\n')
    expect((await kay(['i18n', 'missing', 'en'], root)).stderr).toContain('en is not one of the locales translated from en: fr, de')
  })

  it('accepts every draft of a locale', async () => {
    const root = await project(site)
    const { stdout, code } = await kay(['i18n', 'accept', 'fr'], root)
    const text = await Bun.file(join(root, 'src/messages/fr.ts')).text()

    expect(code).toBe(0)
    expect(stdout).toContain('Accepted 2 drafts in src/messages/fr.ts')
    expect(draftMessages(text)).toEqual([])
    expect(text).toContain('// draft notes about nothing')
    expect((await kay(['i18n', 'accept', 'fr'], root)).stdout).toBe('src/messages/fr.ts holds no draft\n')
    expect((await kay(['i18n', 'accept', 'de'], root)).stderr).toContain('src/messages/de.ts does not exist')
    expect((await kay(['i18n', 'accept', 'it'], root)).stderr).toContain('it is not one of the locales i18n lists: en, fr, de')
    expect((await kay(['i18n', 'accept'], root)).code).toBe(1)
  })

  it('accept --dry-run counts the drafts and leaves the file as it was', async () => {
    const root = await project(site)
    const before = await Bun.file(join(root, 'src/messages/fr.ts')).text()
    const { stdout, code } = await kay(['i18n', 'accept', 'fr', '--dry-run'], root)

    expect(code).toBe(0)
    expect(stdout).toContain('Would accept 2 drafts in src/messages/fr.ts')
    expect(await Bun.file(join(root, 'src/messages/fr.ts')).text()).toBe(before)
  })

  it('gives a library what each locale lacks, with the default locale\'s message for each', async () => {
    const root = await project(site)
    const config = { i18n, extensions: [{ name: 'kay-lib', messages: './lib/messages' }] }

    expect(await missingTranslations(root, config)).toEqual({
      fr: { messages: { 'lib.bye': 'Bye' }, entries: { news: ['launch'] } },
      de: { messages: { 'lib.hello': 'Hello', 'lib.bye': 'Bye', 'nav.home': 'Home', 'nav.about': 'About', 'items': { one: '{count} item', other: '{count} items' } }, entries: { news: ['hello', 'launch'] } },
    })
    expect(await missingTranslations(root, {})).toEqual({})
  })

  it('names a missing entry by the default locale\'s slug, not its translationKey, and counts a translation under another slug as present', async () => {
    const root = await project({
      ...site,
      'src/content/news/en/hello.md': '---\ntitle: Hello\nslug: hello-world\ntranslationKey: hello\n---\n',
      'src/content/news/fr/hello.md': '---\ntitle: Bonjour\nslug: bonjour\ntranslationKey: hello\n---\n',
    })

    expect((await kay(['i18n', 'missing', 'fr'], root)).stdout).toBe('fr lacks 1 message: lib.bye\nfr lacks 1 entry of news: launch\n')
    expect((await kay(['i18n', 'missing', 'de'], root)).stdout).toContain('de lacks 2 entries of news: hello-world, launch')
  })

  it('fails when the default locale\'s messages do not read, rather than saying a locale lacks nothing', async () => {
    const root = await project({ ...site, 'kay.config.ts': `export default { favicon: false, i18n: ${JSON.stringify(i18n)} }\n`, 'src/messages/en.ts': 'export default 1\n' })

    await expect(missingTranslations(root, { i18n })).rejects.toThrow('kay: src/messages/en.ts must export its messages by default')

    const { stdout, stderr, code } = await kay(['i18n', 'missing', 'fr'], root)

    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('src/messages/en.ts must export its messages by default')
  })

  it('refuses a site without i18n', async () => {
    const root = await project({ 'kay.config.ts': 'export default { favicon: false }\n' })
    const { stderr, code } = await kay(['i18n', 'missing'], root)

    expect(code).toBe(1)
    expect(stderr).toContain('kay.config.ts sets no i18n')
  })

  it('alone lists every i18n command, the libraries\' included', async () => {
    const root = await project(site)
    const { stdout, code } = await kay(['i18n'], root)

    expect(code).toBe(0)
    expect(stdout).toContain('Usage: kay i18n missing')
    expect(stdout).toContain('kay i18n accept <locale> [dir]')
    expect(stdout).toContain('kay i18n translate <locale>')

    const wrong = await kay(['i18n', 'nope'], root)

    expect(wrong.code).toBe(1)
    expect(wrong.stderr).toContain('kay: i18n has no command nope')
  })

  it('names a library\'s command module that does not load in one line, and lists the rest', async () => {
    const root = await project({ ...site, 'lib/translate.ts': 'throw new Error(\'broken module\')\n' })
    const { stdout, stderr, code } = await kay(['i18n'], root)

    expect(code).toBe(0)
    expect(stdout).toContain('kay i18n accept <locale> [dir]')
    expect(stdout).toContain('       kay i18n translate\n')
    expect(stderr.trim().split('\n')).toHaveLength(1)
    expect(stderr).toContain('which the extension kay-lib gives as `kay i18n translate`, does not load: broken module')
  })
})

describe('commands an extension adds', () => {
  it('run in the project of the current directory, given its root and config, with their own options and usage', async () => {
    const root = await project(site)
    const { stdout, stderr, code } = await kay(['hello', 'world', 'Ada', '--loud'], root)

    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ who: 'Ada', loud: true, root, locales: ['en', 'fr', 'de'] })
    expect((await kay(['i18n', 'translate', 'fr'], root)).stdout).toBe('translating fr\n')

    const refused = await kay(['hello', 'world'], root)

    expect(refused.code).toBe(1)
    expect(refused.stderr).toBe('kay: hello world needs someone to greet\nUsage: kay hello world <who>\n')
    expect((await kay(['hello', 'world', '--help'], root)).stdout).toBe('Usage: kay hello world <who>\n')
  })

  it('are listed by kay --help under the library\'s name', async () => {
    const root = await project(site)
    const { stdout, code } = await kay(['--help'], root)

    expect(code).toBe(0)
    expect(stdout).toContain('Usage: kay new <dir>')
    expect(stdout).toContain('\n\nFrom kay-lib:\n       kay hello world <who>\n       kay i18n translate <locale>\n')
  })

  it('stop at a name kay has, one under a kay command, or one two extensions give, naming both', async () => {
    const clash = async (commands: string, more = '') => project({ ...library, 'kay.config.ts': `export default { favicon: false, extensions: [{ name: 'kay-lib', commands: ${commands} }${more}] }\n` })

    expect((await kay(['hello', 'world'], await clash('{ check: \'./lib/hello.ts\' }'))).stderr).toBe('kay: the extension kay-lib adds the command `kay check`, which kay has\n')
    expect((await kay(['hello', 'world'], await clash('{ \'i18n missing\': \'./lib/hello.ts\' }'))).stderr).toBe('kay: the extension kay-lib adds the command `kay i18n missing`, which kay has\n')
    expect((await kay(['hello', 'world'], await clash('{ \'check  foo\': \'./lib/hello.ts\' }'))).stderr).toBe('kay: the extension kay-lib adds the command `kay check foo`, which kay\'s `kay check` takes as its arguments\n')
    expect((await kay(['hello', 'world'], await clash('{ \'i18n missing foo\': \'./lib/hello.ts\' }'))).stderr).toBe('kay: the extension kay-lib adds the command `kay i18n missing foo`, which kay\'s `kay i18n missing` takes as its arguments\n')
    expect((await kay(['hello', 'world'], await clash('{ \' \': \'./lib/hello.ts\' }'))).stderr).toBe('kay: the extension kay-lib adds a command with no name\n')
    expect((await kay(['hello', 'world'], await clash('{ i18n: \'./lib/hello.ts\' }'))).stderr).toBe('kay: the extension kay-lib adds the command `kay i18n`, which kay has\n')

    const twice = await kay(['hello', 'world', 'Ada'], await clash('{ \'hello world\': \'./lib/hello.ts\' }', ', { name: \'other-lib\', commands: { \'hello world\': \'./lib/translate.ts\' } }'))

    expect(twice.code).toBe(1)
    expect(twice.stderr).toBe('kay: the extensions kay-lib and other-lib both add the command `kay hello world`\n')
  })

  it('leave a name no one has to the usage, and a module exporting no command said', async () => {
    const root = await project({ ...library, 'lib/bad.ts': 'export const nothing = 1\n', 'kay.config.ts': 'export default { favicon: false, extensions: [{ name: \'kay-lib\', commands: { bad: \'./lib/bad.ts\' } }] }\n' })
    const unknown = await kay(['nope'], root)

    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toStartWith('Usage: kay new')

    const bad = await kay(['bad'], root)

    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('which the extension kay-lib gives as `kay bad`, does not export a command by default')
  })

  it('leave kay --help listing kay\'s own when the config does not load, saying why in one line', async () => {
    const root = await project({ 'kay.config.ts': 'throw new Error(\'config broke\')\n' })
    const { stdout, stderr, code } = await kay(['--help'], root)

    expect(code).toBe(0)
    expect(stdout).toStartWith('Usage: kay new')
    expect(stderr.trim().split('\n')).toHaveLength(1)
    expect(stderr).toContain('kay.config.ts did not load, so the commands its extensions add are not listed: config broke')
  })
})
