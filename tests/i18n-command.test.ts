import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { messageProblems } from '../src/check/messages'
import { projectProblems } from '../src/check/project'
import { flattenMessages } from '../src/runtime/i18n'
import { acceptDrafts, draftMessages, writeDraftMessages } from '../src/server/message-drafts'
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

  it('are reported by kay check as draft-message, at their line', async () => {
    const root = await project(site)
    const problems = await messageProblems(root, i18n, [{ name: 'kay-lib', messages: './lib/messages' }])

    expect(problems.filter(problem => problem.code === 'draft-message')).toEqual([
      { file: 'src/messages/fr.ts', line: 6, message: 'gives nav.about as a draft, which no one has checked yet', code: 'draft-message' },
      { file: 'src/messages/fr.ts', line: 8, message: 'gives items as a draft, which no one has checked yet', code: 'draft-message' },
    ])

    const extensions = [{ name: 'kay-lib', messages: './lib/messages' }]
    const reported = async (lints?: Record<string, 'allow' | 'warn' | 'deny'>) => (await projectProblems(root, { i18n, extensions, lints }, { problems: [], feeds: [], props: new Map() })).filter(problem => problem.code === 'draft-message')

    expect((await reported()).map(({ line, severity, help }) => ({ line, severity, help }))).toEqual([
      { line: 6, severity: 'warning', help: 'check it, then delete its `// draft` comment, or run `kay i18n accept <locale>` for every draft of the locale' },
      { line: 8, severity: 'warning', help: expect.any(String) },
    ])
    expect((await reported({ 'draft-message': 'deny' })).map(({ severity }) => severity)).toEqual(['error', 'error'])
    expect(await reported({ i18n: 'allow' })).toEqual([])
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

    const text = await kay(['i18n', 'missing', '--locale', 'fr'], root)

    expect(text.stdout).toBe('fr lacks 1 message: lib.bye\nfr lacks 1 entry of news: launch\n')
    expect((await kay(['i18n', 'missing', '--locale', 'en'], root)).stderr).toContain('en is not one of the locales translated from en: fr, de')
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
})
