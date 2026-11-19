import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
// `bun scripts/utils-floor.ts [--update]`: what each library imports from `@kaynooo/utils`, held against the lowest version its range allows.
// An app's lockfile keeps the lowest version a range allows, so an import of something added later fails in the app's `kay check` alone (#3446). The exports of that version are recorded in `tests/utils-floor.json`, read from its published tarball by `--update`, so the test that holds them together needs no network.
import { Glob } from 'bun'

const ROOT = join(import.meta.dir, '..')
const TABLE = join(ROOT, 'tests/utils-floor.json')
const PACKAGE = '@kaynooo/utils'
const IMPORT = /\b(?:import|export)\b([^'";]*?\s)from\s*['"]@kaynooo\/utils(?:\/([^'"]+))?['"]/g
const BRACES = /\{([^}]*)\}/
const DYNAMIC_IMPORT = /import\(\s*['"]@kaynooo\/utils(?:\/([^'"]+))?['"]\s*\)/g
const DECLARATION = /^export\s+declare\s+(?:abstract\s+)?(?:async\s+)?(?:function|const\s+enum|const|let|var|class|enum|namespace)\s+([\w$]+)|^export\s+(?:interface|type)\s+([\w$]+)|^export\s+declare\s+(?:interface|type)\s+([\w$]+)/gm
const REEXPORT = /^export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?|^export\s+\*\s+from\s*['"]([^'"]+)['"]/gm
const VERSION = /\d+\.\d+\.\d+/
const INDEX_DECLARATION = /\/index\.d\.ts$/
const DECLARATION_FILE = /\.d\.ts$/
const TYPE_PREFIX = /^type\s+/
const ALIAS = /\s+as\s+/

export interface UtilsImport {
  file: string
  // `browser/clipboard`, or '' for the package root.
  module: string
  names: string[]
}

// The exported names of each module of the package, as its declaration files list them.
export type FloorTable = Record<string, Record<string, string[]>>

export function floorOf(range: string): string | undefined {
  return VERSION.exec(range)?.[0]
}

// Every import of the package in a library's source, with the names it takes.
export function utilsImports(file: string, text: string): UtilsImport[] {
  const found: UtilsImport[] = []

  for (const [, clause = '', module = ''] of text.matchAll(IMPORT))
    found.push({ file, module, names: listed(BRACES.exec(clause)?.[1] ?? '').map(([name]) => name) })

  for (const [, module = ''] of text.matchAll(DYNAMIC_IMPORT))
    found.push({ file, module, names: [] })

  return found
}

// The `name as alias` entries of a braces list, as [name, alias].
function listed(list: string): [string, string][] {
  return list.split(',').map(entry => entry.trim().replace(TYPE_PREFIX, '')).filter(Boolean).map((entry) => {
    const [name = '', alias = name] = entry.split(ALIAS)

    return [name, alias]
  })
}

// The imports of every library, by the floor of the range its package.json asks for.
export async function libraryImports(): Promise<{ library: string, floor: string | undefined, imports: UtilsImport[] }[]> {
  const result = []

  for (const path of (await Array.fromAsync(new Glob('packages/*/package.json').scan(ROOT))).sort()) {
    const dir = path.replace('/package.json', '')
    const manifest = await Bun.file(join(ROOT, path)).json() as { dependencies?: Record<string, string>, peerDependencies?: Record<string, string> }
    const range = manifest.dependencies?.[PACKAGE] ?? manifest.peerDependencies?.[PACKAGE]
    const imports: UtilsImport[] = []

    for (const file of await Array.fromAsync(new Glob('src/**/*.{ts,tsx,kay}').scan(join(ROOT, dir))))
      imports.push(...utilsImports(`${dir}/${file}`, await Bun.file(join(ROOT, dir, file)).text()))

    const floor = range === undefined ? undefined : floorOf(range)

    if (imports.length > 0 && floor === undefined)
      throw new Error(`${dir} imports ${PACKAGE} and its range ${range ?? '(none)'} names no x.y.z floor`)

    result.push({ library: dir, floor, imports })
  }

  return result
}

// What each import asks for that the recorded version lacks, as `file: module { name }`.
export function missingFrom(table: Record<string, string[]>, imports: UtilsImport[]): string[] {
  const missing: string[] = []

  for (const { file, module, names } of imports) {
    const exported = table[module]

    if (exported === undefined)
      missing.push(`${file}: ${PACKAGE}/${module} does not exist`)
    else
      missing.push(...names.filter(name => name !== 'default' && !exported.includes(name)).map(name => `${file}: ${PACKAGE}/${module} has no ${name}`))
  }

  return missing
}

function declaredNames(dist: Map<string, string>, file: string, seen = new Set<string>()): string[] {
  const text = dist.get(file)

  if (text === undefined || seen.has(file))
    return []

  seen.add(file)

  const names = [...text.matchAll(DECLARATION)].map(([, a, b, c]) => (a ?? b ?? c)!)

  for (const [, list, from, star] of text.matchAll(REEXPORT)) {
    if (list !== undefined)
      names.push(...listed(list).map(([, alias]) => alias))
    else
      names.push(...declaredNames(dist, resolveDeclaration(dist, file, (from ?? star)!), seen))
  }

  return [...new Set(names)].sort()
}

function resolveDeclaration(dist: Map<string, string>, from: string, target: string): string {
  const parts = from.split('/').slice(0, -1)

  for (const part of target.split('/')) {
    if (part === '..')
      parts.pop()
    else if (part !== '.')
      parts.push(part)
  }

  const base = parts.join('/')

  return dist.has(`${base}.d.ts`) ? `${base}.d.ts` : `${base}/index.d.ts`
}

// The published tarball of one version, from the registry `bun pm view` resolves for the package.
async function exportsOf(version: string): Promise<Record<string, string[]>> {
  const view = Bun.spawnSync(['bun', 'pm', 'view', `${PACKAGE}@${version}`, 'dist.tarball'], { cwd: ROOT })
  const url = view.stdout.toString().trim().split('\n').at(-1)!

  if (!url.startsWith('https://'))
    throw new Error(`${PACKAGE}@${version} is not on the registry: ${view.stderr.toString() || url}`)

  const dir = await mkdtemp(join(tmpdir(), 'utils-floor-'))

  try {
    const response = await fetch(url)

    if (!response.ok)
      throw new Error(`${url}: ${response.status}`)

    await Bun.write(join(dir, 'package.tgz'), response)

    if (Bun.spawnSync(['tar', 'xzf', 'package.tgz'], { cwd: dir }).exitCode !== 0)
      throw new Error(`${url} did not unpack`)

    const dist = new Map<string, string>()

    for (const file of await Array.fromAsync(new Glob('package/dist/**/*.d.ts').scan(dir)))
      dist.set(file.slice('package/dist/'.length), await Bun.file(join(dir, file)).text())

    const table: Record<string, string[]> = {}

    for (const file of [...dist.keys()].sort()) {
      const module = file === 'index.d.ts' ? '' : file.replace(INDEX_DECLARATION, '').replace(DECLARATION_FILE, '')

      table[module] = declaredNames(dist, file)
    }

    return table
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const floors = new Set((await libraryImports()).flatMap(({ floor }) => floor === undefined ? [] : [floor]))
  const table = await Bun.file(TABLE).exists() ? await Bun.file(TABLE).json() as FloorTable : {}
  const next: FloorTable = {}

  for (const floor of [...floors].sort()) {
    if (process.argv.includes('--update'))
      next[floor] = await exportsOf(floor)
    else if (table[floor] === undefined)
      next[floor] = {}
    else
      next[floor] = table[floor]
  }

  if (process.argv.includes('--update'))
    await Bun.write(TABLE, `${JSON.stringify(next, null, 2)}\n`)

  const problems = (await libraryImports()).flatMap(({ floor, imports }) => floor === undefined ? [] : missingFrom(next[floor]!, imports))

  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`)
    process.exit(1)
  }
}
