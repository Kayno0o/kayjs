import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { compileKay, formatDiagnostic } from '../src/compiler'
import { LINTS } from '../src/compiler/lints'
import { formatKay } from '../src/format'

const KAY_BLOCK = /```kay\n([\s\S]*?)```/g
const root = join(import.meta.dir, '..')
// llms.txt and every doc of llms/, read as one.
const spec = (await Promise.all(['llms.txt', ...(await readdir(join(root, 'llms'))).map(name => `llms/${name}`)].map(async file => Bun.file(join(root, file)).text()))).join('\n')
const examples = [...spec.matchAll(KAY_BLOCK)].map(match => match[1]!)
const IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(kay(?:\/[^']*)?)'/g
// A name the prose places, as "`shutdown(app)` from `kay/server`".
const MENTION = /`(\w+)(?:\([^`]*\))?` from `(kay(?:\/[\w/-]+)?)`/g
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

  for (const [, name, module] of spec.matchAll(MENTION))
    add(module!, name!)

  return found
}

// The spec's examples are what an LLM copies, so each one has to compile and already be formatted.
describe('llms.txt and its docs', () => {
  it('has examples', () => {
    expect(examples.length).toBeGreaterThan(5)
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
    await Bun.write(join(dir, 'imports.ts'), [...imports].map(([module, names]) => `export type { ${[...names].join(', ')} } from '${module}'\n`).join(''))
    await Bun.write(join(dir, 'tsconfig.json'), JSON.stringify({ extends: '../../../tsconfig.json', include: ['imports.ts'] }))

    try {
      const checked = Bun.spawn([join(import.meta.dir, '../node_modules/.bin/tsgo'), '--noEmit', '-p', join(dir, 'tsconfig.json')], { stdout: 'pipe', stderr: 'pipe' })
      const output = await new Response(checked.stdout).text()

      expect(output).toBe('')
      expect(await checked.exited).toBe(0)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('keeps what generated code and kay\'s own build import off the public entries', async () => {
    const runtime = await import('kay')
    const server = await import('kay/server')

    expect(Object.keys(await import('kay/compiler')).sort()).toEqual(['compileKay', 'formatDiagnostic'])
    expect(Object.keys(await import('kay/image'))).toEqual(['image', 'shareCard', 'shareImage'])
    expect(Object.keys(await import('kay/internal')).sort()).toEqual(['actionStub', 'autoDefer', 'formAction', 'formChecked', 'formError', 'formInvalid', 'formProtection', 'formValue', 'isAction', 'registerActions', 'registerImage'])
    expect(Object.keys(await import('kay/internal/server'))).toEqual(['probeHealth', 'registerBundle'])
    expect(['actionStub', 'formAction', 'isAction', 'registerActions'].filter(name => name in runtime)).toEqual([])
    expect(['registerBundle', 'shutDown', 'events'].filter(name => name in server)).toEqual([])
    expect(server).toMatchObject({ shutdown: expect.any(Function), eventStream: expect.any(Function) })
    expect(Object.keys(await import('kay/i18n')).filter(name => name === 'runInLocale' || name === 'localeState')).toEqual([])
  })
})
