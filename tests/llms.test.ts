import { readdirSync } from 'node:fs'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { ARCHIVES } from '../scripts/whats-new'
import { compileKay, formatDiagnostic } from '../src/compiler'
import { KAY_VALUES } from '../src/compiler/kay-exports'
import { LINTS } from '../src/compiler/lints'
import { nativeExe } from '../src/compiler/native-typescript'
import { formatKay } from '../src/format'

// A doc an agent reads whole stays under this many bytes, as a tool output over 30 KB is cut to a preview; a release that grows whats-new.md or upgrading.md past it moves its oldest minor into the archive file, and a library's llms.txt is an index of topic files under llms/.
const MAX_DOC_BYTES = 25_000
const KAY_BLOCK = /```kay\n([\s\S]*?)```/g
const root = join(import.meta.dir, '..')
// llms.txt and every doc of llms/, read as one.
const spec = (await Promise.all(['llms.txt', ...(await readdir(join(root, 'llms'))).map(name => `llms/${name}`)].map(async file => Bun.file(join(root, file)).text()))).join('\n')
const examples = [...spec.matchAll(KAY_BLOCK)].map(match => match[1]!)
const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(kay(?:\/[^']*)?)'/g
const NAMED = /`(\w+)(?:<[^`>]*>)?(?:\([^`]*\))?`/g
// Names the prose places, as "`shutdown(app)` from `kay/server`" or "`onCleanup`, `untrack` and `flush` come from `kay` too".
const MENTION = /((?:`\w+(?:<[^`>]*>)?(?:\([^`]*\))?`(?:, | and | or ))*`\w+(?:<[^`>]*>)?(?:\([^`]*\))?`),? (?:(?:imported |comes? )?from|in) `(kay(?:\/[\w/-]+)?)`/g
// The entry points an app imports from, without what compiled files import (llms/project.md).
const PUBLIC_ENTRIES = ['kay', 'kay/bun', 'kay/cache', 'kay/compiler', 'kay/content', 'kay/dev-tool', 'kay/edit', 'kay/i18n', 'kay/icons', 'kay/image', 'kay/markdown', 'kay/mount', 'kay/params', 'kay/seo', 'kay/server', 'kay/test']
const NEGATED_SKIP = /!\s*browserPath\(\)/
const MARKDOWN_OR_TS = /\.(?:md|ts)$/
const BEFORE = /before \d+\.\d+(?:\.\d+)?/
const LEADING_TYPE = /^type\s+/
const ALIAS = /\s+as\s+(?:\S.*)?$/

// Every name the spec imports from kay or says comes from it, by entry point.
function documentedImports(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>()
  const add = (module: string, name: string) => found.set(module, (found.get(module) ?? new Set()).add(name))

  for (const [, names, module] of spec.matchAll(IMPORT)) {
    for (const name of names!.split(',').map(name => name.trim().replace(LEADING_TYPE, '').replace(ALIAS, '')).filter(name => name !== ''))
      add(module!, name)
  }

  for (const [, names, module] of spec.matchAll(MENTION)) {
    for (const [, name] of names!.matchAll(NAMED))
      add(module!, name!)
  }

  return found
}

// The spec's examples are what an LLM copies, so each one has to compile and already be formatted.
describe('llms.txt and its docs', () => {
  it('has examples', () => {
    expect(examples.length).toBeGreaterThan(5)
  })

  it('keeps every doc under the size an agent reads with one command', async () => {
    const files = [...(await readdir(join(root, 'llms'))).map(name => `llms/${name}`), ...new Bun.Glob('packages/*/llms.txt').scanSync({ cwd: root }), ...new Bun.Glob('packages/*/llms/*.md').scanSync({ cwd: root })]

    expect(files.length).toBeGreaterThan(30)
    expect(files.filter(file => Bun.file(join(root, file)).size >= MAX_DOC_BYTES).map(file => `${file}: ${Bun.file(join(root, file)).size}`)).toEqual([])
  })

  it('says in llms.txt the release each archive starts before, as the archive itself does', async () => {
    const index = await Bun.file(join(root, 'llms.txt')).text()
    const before = (text: string) => BEFORE.exec(text)?.[0]

    for (const [, archive] of ARCHIVES) {
      const line = index.split('\n').find(line => line.includes(`(${archive})`))

      expect(before(line ?? '')).toBeDefined()
      expect(before(line ?? '')).toBe(before(await Bun.file(join(root, archive)).text()))
    }
  })

  it('lists every lint at its default level', () => {
    expect(Object.entries(LINTS).filter(([name, lint]) => !spec.includes(`| \`${name}\` | ${lint.level} |`)).map(([name]) => name)).toEqual([])
  })

  it.each(examples.map((source, index) => [index, source]))('example %d compiles cleanly and is formatted', (_index, source) => {
    const filename = source.startsWith('--- server') ? 'src/routes/example.kay' : 'src/example.kay'
    const { diagnostics } = compileKay(source, filename)

    expect(diagnostics.map(diagnostic => formatDiagnostic(source, filename, diagnostic))).toEqual([])
    expect(formatKay(source).code).toBe(source)
  })

  it('names an entry point the package exports', async () => {
    expect(await import('kay/server')).toHaveProperty('pages')
    expect(await import('kay/server')).toMatchObject({ clientAddress: expect.any(Function), rateKey: expect.any(Function) })
  })

  it('names only what the package exports, types included', async () => {
    const imports = documentedImports()
    const dir = join(import.meta.dir, '../node_modules/.cache/llms-imports')

    expect(imports.get('kay/server')?.has('shutdown')).toBe(true)
    await mkdir(dir, { recursive: true })
    // A file per entry point, as two may export one name, `t` say.
    await Promise.all([...imports].map(async ([module, names], index) => Bun.write(join(dir, `imports-${index}.ts`), `export type { ${[...names].join(', ')} } from '${module}'\n`)))
    await Bun.write(join(dir, 'tsconfig.json'), JSON.stringify({ extends: '../../../tsconfig.json', include: ['imports-*.ts'] }))

    try {
      const checked = Bun.spawn([nativeExe(), '--noEmit', '-p', join(dir, 'tsconfig.json')], { stdout: 'pipe', stderr: 'pipe' })
      const output = await new Response(checked.stdout).text()

      expect(output).toBe('')
      expect(await checked.exited).toBe(0)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('says where each export it names is imported from', async () => {
    const placed = new Set([...documentedImports().values()].flatMap(names => [...names]))
    const named = new Set([...spec.matchAll(NAMED)].map(match => match[1]!))
    // A default export, such as kay/bun's plugin for bunfig, is imported by no name
    const exported = new Set((await Promise.all(PUBLIC_ENTRIES.map(async entry => Object.keys(await import(entry))))).flat().filter(name => name !== 'default'))
    const implicit = new Set([...KAY_VALUES, 't'])

    expect([...exported].filter(name => named.has(name) && !placed.has(name) && !implicit.has(name)).sort()).toEqual([])
  })

  it('lists every value of kay for the compiler to import where a file reads it unimported', async () => {
    expect([...KAY_VALUES].sort()).toEqual(Object.keys(await import('kay')).sort())
  })

  it('keeps what generated code and kay\'s own build import off the public entries', async () => {
    const runtime = await import('kay')
    const server = await import('kay/server')

    expect(Object.keys(await import('kay/compiler')).sort()).toEqual(['compileKay', 'formatDiagnostic'])
    expect(Object.keys(await import('kay/image'))).toEqual(['image', 'shareCard', 'shareImage'])
    expect(Object.keys(await import('kay/internal')).sort()).toEqual(['actionStub', 'autoDefer', 'formAction', 'formChecked', 'formDescribed', 'formError', 'formInvalid', 'formMarked', 'formProtection', 'formValue', 'isAction', 'registerActions', 'registerImage', 'registerPlaceholder', 'reviveActions'])
    expect(Object.keys(await import('kay/internal/server'))).toEqual(['buildingWithoutEnv', 'probeHealth', 'registerBundle', 'registerEmbeddedMap'])
    expect(Object.keys(await import('kay/internal/title'))).toEqual(['pageTitle'])
    expect(Object.keys(await import('kay/library')).sort()).toEqual(['GENERATE_SECRET', 'KAY_DIR', 'MIN_SECRET_LENGTH', 'READ_METHODS', 'RESTART_RELOAD', 'RedirectRefused', 'RedirectRefusedError', 'UNSAFE_ATTRIBUTE', 'UNSAFE_TAGS', 'acceptedLocales', 'actionTool', 'addRuntimeRedirect', 'asConfigError', 'byteSize', 'checkAnswer', 'clearMissing', 'configError', 'configuredHighlighter', 'configuredRedirects', 'configuredSite', 'currentRequest', 'dismissMissing', 'durationSeconds', 'durationWords', 'escapeHtml', 'inFlightWork', 'invalidateLocally', 'isUrlAttribute', 'jsonSchemaOf', 'keyedDigest', 'lazily', 'localizedEntry', 'matchLocale', 'missingTranslations', 'nameUser', 'onKeysInvalidated', 'openWith', 'optionMs', 'overHttps', 'parseEvents', 'redirectMovedPage', 'removeRuntimeRedirect', 'runtimeRedirects', 'safeCode', 'sameText', 'sealWith', 'serverRoot', 'setSite', 'sitePaths', 'siteWithBase', 'sourceHash', 'stoppers', 'trackDetached', 'unansweredPaths', 'underKayDev', 'userOf', 'validLocale', 'weakSecrets', 'writeDraftEntry', 'writeDraftMessages'])
    expect(['actionStub', 'formAction', 'isAction', 'registerActions', 'reviveActions'].filter(name => name in runtime)).toEqual([])
    expect(['registerBundle', 'shutDown', 'events'].filter(name => name in server)).toEqual([])
    expect(server).toMatchObject({ shutdown: expect.any(Function), eventStream: expect.any(Function) })
    expect(Object.keys(await import('kay/i18n')).filter(name => name === 'runInLocale' || name === 'localeState')).toEqual([])
  })
})

// The markdown and TypeScript files under `dir`, a folder named node_modules never entered.
function withoutModules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)

    if (entry.isDirectory())
      return entry.name === 'node_modules' ? [] : withoutModules(path)

    return MARKDOWN_OR_TS.test(entry.name) ? [path] : []
  })
}

describe('the browser test skip', () => {
  // `browserPath()` is a string or undefined, which the lint preset refuses as a condition.
  it('is written where the docs, the examples and the source say it as the lint preset accepts it', async () => {
    const files = ['llms', 'docs/src/content/docs', 'examples', 'src/test'].flatMap(folder => withoutModules(join(root, folder)))
    const negated = (await Promise.all(files.map(async file => NEGATED_SKIP.test(await Bun.file(file).text()) ? file : ''))).filter(file => file !== '')

    expect(negated).toEqual([])
  })
})
