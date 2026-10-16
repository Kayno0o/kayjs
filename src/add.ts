import type { Feature } from './templates'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'
import { FEATURE_NAMES, FEATURES, originHost, projectFiles } from './new'

// Files whose lines are a set: a feature adds the lines the file lacks and keeps the rest.
const LINE_FILES = new Set(['.gitignore', '.dockerignore'])
// Files describing the project to agents: rewritten while unedited, left alone once the author wrote in them.
const SOFT_FILES = new Set(['AGENTS.md'])
// A whole import statement, a multi-line one included, with its line break.
const IMPORT_STATEMENT = /^import\b(?:[^;'"]|'[^']*'|"[^"]*")*?(?:from\s*)?(?:'[^']*'|"[^"]*");?[ \t]*\r?\n/gm
const CALLEE = /^(\w+)\(/
const KEY = /\bextensions\s*:/
const CLOSED = /^\s*\]/
const DEFINE_CONFIG = /defineConfig\(\{[ \t]*\n?/
const EXTENSIONS = /extensions:\s*\[/
const NEWLINE = /\r?\n/
// A `KEY=value` line of a .env file, with the `export ` some write before it.
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=(.*)$/
const QUOTED = /^(['"])(.*?)\1(?:\s+#.*)?$/
const INLINE_COMMENT = /\s+#.*$/

// What a library says `kay add <name>` writes: its files, and the entry it adds to `extensions` in kay.config.ts.
export interface LibraryFeature {
  description: string
  // Paths relative to the project root, with their content; a file the project has already is left alone when identical and reported otherwise.
  files?: Record<string, string> | undefined
  // The import line and the expression added to `extensions: [...]`.
  extension?: { import: string, expression: string } | undefined
  // Printed once the feature is added: what the author still has to decide.
  notes?: readonly string[] | undefined
}

// The libraries that register features: `kay add mail` adds their packages, the first of which is asked what to write through its `/add` module. A kayjs package takes kay's own minor, any other the range kay itself uses.
export const LIBRARIES: Record<string, string[]> = { mail: ['@kaynooo/kayjs-mail'], cms: ['@kaynooo/kayjs-cms', '@kaynooo/kayjs-ui', '@iconify-json/tabler'] }

export interface AddResult {
  written: string[]
  installed: boolean
  notes: string[]
}

interface Manifest {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface Plan {
  writes: Map<string, string>
  conflicts: string[]
  // Printed once done: what the plan left alone and the author should know.
  notes: string[]
}

function unquote(value: string): string {
  const trimmed = value.trim()

  return QUOTED.exec(trimmed)?.[2] ?? trimmed.replace(INLINE_COMMENT, '')
}

async function read(path: string): Promise<string | undefined> {
  return existsSync(path) ? readFile(path, 'utf8') : undefined
}

// The features a project already holds, read off the files `kay new` writes for each.
export async function detectFeatures(dir: string): Promise<Set<Feature>> {
  const at = (path: string) => existsSync(join(dir, path))
  const css = await read(join(dir, 'src/app.css'))
  const checks: [Feature, boolean][] = [
    ['server', at('src/server.ts')],
    ['starter', at('src/components/header.kay')],
    ['tailwind', css?.includes('@import \'tailwindcss\'') === true],
    ['accents', at('src/theme.ts')],
    ['eslint', at('eslint.config.ts')],
    ['tests', at('bunfig.toml')],
    ['ci', ['.forgejo', '.github'].some(host => at(`${host}/workflows/test.yml`) || at(`${host}/workflows/pages.yml`))],
    ['docker', at('Dockerfile')],
    ['auth', at('src/routes/login.kay') && at('src/db/member.ts')],
    ['postgres', at('compose.dev.yaml')],
    ['ws', at('src/api/online.ts')],
  ]

  return new Set(checks.filter(([, present]) => present).map(([feature]) => feature))
}

// The lines a hand edit has to remove and add to turn `from` into `to`, in file order: the lines kept are the longest run both files share.
export function handEdit(from: string, to: string): string {
  const before = from.split(NEWLINE)
  const after = to.split(NEWLINE)
  // kept[i][j] is how many lines a diff keeps between before[i..] and after[j..].
  const kept = Array.from({ length: before.length + 1 }, () => Array.from<number>({ length: after.length + 1 }).fill(0))

  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--)
      kept[i]![j] = before[i] === after[j] ? kept[i + 1]![j + 1]! + 1 : Math.max(kept[i + 1]![j]!, kept[i]![j + 1]!)
  }

  const lines: string[] = []
  let i = 0
  let j = 0

  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      i++
      j++
    }
    else if (j === after.length || (i < before.length && kept[i + 1]![j]! >= kept[i]![j + 1]!)) {
      lines.push(`-${before[i++]!}`)
    }
    else {
      lines.push(`+${after[j++]!}`)
    }
  }

  return lines.filter(line => line.slice(1).trim() !== '').join('\n')
}

// `current` with the lines of `wanted` it lacks at the end.
function withLines(current: string, wanted: string): string {
  const have = new Set(current.split(NEWLINE))
  const missing = wanted.split(NEWLINE).filter(line => line !== '' && !have.has(line))

  if (missing.length === 0)
    return current

  return `${current === '' || current.endsWith('\n') ? current : `${current}\n`}${missing.join('\n')}\n`
}

// kay.config.ts with an import and an `extensions` entry added, or undefined when it is not a plain `defineConfig({ ... })` with no `extensions` or a literal list; an extension the config already calls is left as it is.
export function addExtension(config: string, extension: { import: string, expression: string }): string | undefined {
  const define = DEFINE_CONFIG.exec(config)

  if (define === null)
    return undefined

  const callee = (CALLEE).exec(extension.expression)?.[1]

  if (callee !== undefined && new RegExp(`\\b${callee}\\(`).test(config))
    return config

  const hasKey = KEY.test(config)
  const list = EXTENSIONS.exec(config)

  if (hasKey && list === null)
    return undefined

  const at = list === null ? define.index + define[0].length : list.index + list[0].length
  const empty = list !== null && CLOSED.test(config.slice(at))
  const entry = list === null ? `${define[0].endsWith('\n') ? '' : '\n'}  extensions: [${extension.expression}],\n` : `${extension.expression}${empty ? '' : ', '}`
  const next = `${config.slice(0, at)}${entry}${config.slice(at)}`

  if (extension.import === '' || (callee !== undefined && new RegExp(`import[^;]*\\b${callee}\\b[^;]*from`).test(next)))
    return next

  const end = [...next.matchAll(IMPORT_STATEMENT)].at(-1)
  const head = end === undefined ? 0 : end.index + end[0].length

  return `${next.slice(0, head)}${extension.import}\n${next.slice(head)}`
}

// Merges the scripts and dependencies a feature needs into the project's package.json: a script is replaced only while it is still what `kay new` wrote for the features the project had.
function mergeManifest(current: Manifest, old: Manifest, next: Manifest, conflicts: string[]): Manifest {
  const scripts = { ...current.scripts }
  const merged: Manifest = { ...current, scripts, dependencies: { ...current.dependencies }, devDependencies: { ...current.devDependencies } }

  for (const [name, command] of Object.entries(next.scripts ?? {})) {
    const have = scripts[name]

    if (have === undefined || have === old.scripts?.[name])
      scripts[name] = command
    else if (have !== command)
      conflicts.push(`package.json: the script "${name}" is \`${have}\`, which the feature changes to \`${command}\`: set it by hand`)
  }

  for (const [name, command] of Object.entries(old.scripts ?? {})) {
    if (next.scripts?.[name] === undefined && scripts[name] === command)
      delete scripts[name]
  }

  for (const group of ['dependencies', 'devDependencies'] as const) {
    for (const [name, range] of Object.entries(next[group] ?? {})) {
      if (!(name in merged.dependencies!) && !(name in merged.devDependencies!))
        merged[group]![name] = range
    }
  }

  for (const group of ['scripts', 'dependencies', 'devDependencies'] as const) {
    if (current[group] === undefined && Object.keys(merged[group]!).length === 0)
      delete merged[group]
  }

  return merged
}

async function readManifest(dir: string): Promise<{ text: string, manifest: Manifest }> {
  const text = await read(join(dir, 'package.json'))

  if (text === undefined)
    throw new Error(`kay add: ${dir} has no package.json`)

  let manifest: unknown

  try {
    manifest = JSON.parse(text)
  }
  catch {
    throw new Error('kay add: package.json is not valid JSON, so the dependencies and scripts the feature needs are yours to add')
  }

  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest))
    throw new Error('kay add: package.json is not an object')

  return { text, manifest }
}

// The session secret and the database URL a feature needs: a new .env is written whole, an existing one gets the keys it lacks and a conflict for one set to something else.
function mergeEnv(disk: string | undefined, content: string, { writes, conflicts }: Plan): void {
  if (disk === undefined) {
    writes.set('.env', content)

    return
  }

  const entries = (text: string) => text.split(NEWLINE).map(line => ENV_LINE.exec(line)).filter(match => match !== null)
  const have = new Map(entries(disk).map(match => [match[1]!, match] as const))
  const missing: string[] = []

  for (const [line, key, value] of entries(content)) {
    const existing = have.get(key!)

    if (existing === undefined)
      missing.push(line)
    else if (unquote(existing[2]!) !== unquote(value!) && key !== 'SESSION_SECRET')
      conflicts.push(`.env: ${existing[0].trim()} is not what the feature uses: set ${line} by hand`)
  }

  if (missing.length > 0)
    writes.set('.env', withLines(disk, missing.join('\n')))
}

// What adding the core features changes: the files to write, and the files that are not in the shape `kay new` writes.
async function planCore(dir: string, core: readonly Feature[]): Promise<Plan> {
  const { text, manifest } = await readManifest(dir)
  const kay = manifest.dependencies?.kay

  if (kay === undefined)
    throw new Error('kay add: package.json has no kay dependency, so this is not a kay project')

  const plan: Plan = { writes: new Map(), conflicts: [], notes: [] }

  if (core.length === 0)
    return plan

  const current = await detectFeatures(dir)
  const wanted = new Set([...current, ...core])

  for (const feature of core) {
    const missing = FEATURES[feature].needs.filter(need => !wanted.has(need))

    if (missing.length > 0)
      throw new Error(`kay add: ${feature} needs ${missing.join(' and ')}: run \`kay add ${[...missing, feature].join(',')}\` to add them together`)
  }

  const { writes, conflicts, notes } = plan
  // The project may have been renamed since `kay new` named its package after the directory, so the templates take its own name.
  const named = join(dirname(dir), manifest.name ?? basename(dir))
  const host = await hostOf(dir)
  const [old, next] = await Promise.all([projectFiles(named, current, kay, {}, host), projectFiles(named, wanted, kay, {}, host)])

  for (const [path, content] of Object.entries(next)) {
    const disk = await read(join(dir, path))
    const was = old[path]

    if (path === 'package.json') {
      const merged = mergeManifest(manifest, JSON.parse(was!) as Manifest, JSON.parse(content) as Manifest, conflicts)

      if (!isDeepStrictEqual(merged, JSON.parse(text)))
        writes.set(path, `${JSON.stringify(merged, null, 2)}\n`)
    }
    else if (path === '.env') {
      mergeEnv(disk, content, plan)
    }
    else if (LINE_FILES.has(path)) {
      const merged = disk === undefined ? content : withLines(disk, content)

      if (merged !== disk)
        writes.set(path, merged)
    }
    else if (was !== content && disk !== content) {
      if (was === undefined && disk === undefined)
        writes.set(path, content)
      else if (was === undefined)
        conflicts.push(`${path} exists and is not the file the feature writes: add\n${handEdit(disk!, content)}`)
      // A file both sets write, differently: replaced while it is still what `kay new` wrote.
      else if (disk === was)
        writes.set(path, content)
      else if (disk === undefined)
        notes.push(`${path} was deleted, so it is not written back: add it by hand if the feature needs it`)
      else if (!SOFT_FILES.has(path))
        conflicts.push(`${path} is not what \`kay new\` wrote, so apply this by hand:\n${handEdit(was, content)}`)
    }
  }

  return plan
}

async function spawn(command: string[], dir: string): Promise<{ code: number, output: string }> {
  const child = Bun.spawn(command, { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, output: `${out}${err}` }
}

// The host whose workflows the project uses: its origin remote says it, else the folder already there, else Forgejo.
async function hostOf(dir: string): Promise<'github' | 'forgejo'> {
  const remote = await originHost(dir)

  if (remote !== undefined)
    return remote

  return existsSync(join(dir, '.github/workflows')) && !existsSync(join(dir, '.forgejo/workflows')) ? 'github' : 'forgejo'
}

const LOCK_FILES = ['bun.lock', 'bun.lockb']

// The root of the monorepo around `dir`, where `bun add` rewrites the lockfile.
async function workspaceRoot(dir: string): Promise<string | undefined> {
  for (let up = dirname(dir); up !== dirname(up); up = dirname(up)) {
    try {
      const manifest = JSON.parse(await read(join(up, 'package.json')) ?? 'null') as { workspaces?: unknown } | null

      if (manifest?.workspaces !== undefined)
        return up
    }
    catch {}
  }

  return undefined
}

// What package.json and the lockfile held, a missing file as undefined, with the lockfile of the monorepo root when there is one. Keys are paths from `dir`.
export async function snapshot(dir: string): Promise<Map<string, Buffer | undefined>> {
  const root = await workspaceRoot(dir)
  const paths = ['package.json', ...LOCK_FILES, ...root === undefined ? [] : LOCK_FILES.map(name => relative(dir, join(root, name)))]

  return new Map(await Promise.all(paths.map(async path => [path, existsSync(join(dir, path)) ? Buffer.from(await Bun.file(join(dir, path)).arrayBuffer()) : undefined] as const)))
}

// Puts every file back, and goes on past one it cannot so that the others are not left changed.
export async function restore(dir: string, kept: Map<string, Buffer | undefined>): Promise<void> {
  const failed: string[] = []

  for (const [path, content] of kept) {
    try {
      if (content === undefined)
        await rm(join(dir, path), { force: true })
      else
        await writeFile(join(dir, path), content)
    }
    catch (error) {
      failed.push(`${path} (${messageOf(error)})`)
    }
  }

  if (failed.length > 0)
    throw new Error(`kay add: ${failed.join(', ')} could not be put back: check them with git`)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Restores, then throws the error that made it, with what the restore itself failed on after it.
async function restoreAndThrow(dir: string, kept: Map<string, Buffer | undefined>, error: unknown): Promise<never> {
  try {
    await restore(dir, kept)
  }
  catch (restoreError) {
    throw new Error(`${messageOf(error)}\n\n${messageOf(restoreError)}`, { cause: error })
  }

  throw error
}

async function loadLibrary(dir: string, name: string): Promise<LibraryFeature> {
  let path: string

  try {
    path = Bun.resolveSync(`${LIBRARIES[name]![0]!}/add`, dir)
  }
  catch {
    throw new Error(`kay add: ${LIBRARIES[name]![0]!} is not installed, and --no-install keeps kay add from installing it: it has to be installed to say what it writes`)
  }

  const module = await import(path) as { default?: LibraryFeature }

  if (typeof module.default?.description !== 'string')
    throw new Error(`kay add: ${LIBRARIES[name]![0]!}/add does not export a feature as its default`)

  return module.default
}

function failIfConflicts({ conflicts }: Plan): void {
  if (conflicts.length > 0)
    throw new Error(`kay add: nothing was written\n\n${conflicts.join('\n\n')}`)
}

// Packages `kay new` lists under devDependencies.
const DEV_PACKAGES = new Set(['@iconify-json/tabler'])

// Installs what the libraries need and the project lacks: a kayjs package at kay's own minor, any other at the range kay uses, the dev ones in a call of their own.
async function installPackages(dir: string, missing: readonly string[], bun: string): Promise<void> {
  const own = JSON.parse(await readFile(join(import.meta.dir, '../package.json'), 'utf8')) as { version: string, devDependencies: Record<string, string> }
  const spec = (name: string) => name.startsWith('@kaynooo/kayjs-') ? `${name}@~${own.version}` : `${name}@${own.devDependencies[name]!}`

  for (const [flags, names] of [[[], missing.filter(name => !DEV_PACKAGES.has(name))], [['-d'], missing.filter(name => DEV_PACKAGES.has(name))]] as const) {
    if (names.length === 0)
      continue

    const added = await spawn([bun, 'add', ...flags, ...names.map(spec)], dir)

    if (added.code !== 0)
      throw new Error(`kay add: bun add failed, nothing was written\n${added.output}`)
  }
}

// Asks each installed library what it writes, adding its files, its extension and its notes to the plan.
async function planLibraries(dir: string, libraries: readonly string[], plan: Plan): Promise<void> {
  for (const library of libraries) {
    const feature = await loadLibrary(dir, library)

    for (const [path, content] of Object.entries(feature.files ?? {})) {
      const disk = await read(join(dir, path))

      if (disk === undefined)
        plan.writes.set(path, content)
      else if (disk !== content)
        plan.conflicts.push(`${path} exists and is not the file ${library} writes: add\n${handEdit(disk, content)}`)
    }

    if (feature.extension !== undefined) {
      const disk = await read(join(dir, 'kay.config.ts')) ?? ''
      const next = addExtension(plan.writes.get('kay.config.ts') ?? disk, feature.extension)!

      if (next !== disk)
        plan.writes.set('kay.config.ts', next)
    }

    plan.notes.push(...feature.notes ?? [])
  }
}

// The libraries are installed first, as one cannot be asked what it writes before; any refusal after that restores package.json and the lockfile. Returns the plan the libraries completed.
async function addLibraries(dir: string, core: readonly Feature[], libraries: readonly string[], plan: Plan, options: AddOptions): Promise<Plan> {
  const config = plan.writes.get('kay.config.ts') ?? await read(join(dir, 'kay.config.ts'))

  if (config === undefined || addExtension(config, { import: '', expression: '' }) === undefined)
    throw new Error('kay add: nothing was written\n\nkay.config.ts has no `defineConfig({ ... })` to add an extension to: add it to `extensions` by hand')

  const { manifest } = await readManifest(dir)
  const missing = libraries.flatMap(library => LIBRARIES[library]!).filter(name => manifest.dependencies?.[name] === undefined && manifest.devDependencies?.[name] === undefined)
  const kept = await snapshot(dir)

  try {
    let next = plan

    if (missing.length > 0 && options.install !== false) {
      await installPackages(dir, missing, options.bun ?? process.execPath)

      // The package.json changed on disk, so the merge starts over from it.
      next = await planCore(dir, core)
      failIfConflicts(next)
    }

    await planLibraries(dir, libraries, next)
    failIfConflicts(next)

    return next
  }
  catch (error) {
    return restoreAndThrow(dir, kept, error)
  }
}

async function writePlan(dir: string, { writes }: Plan): Promise<string[]> {
  const written = [...writes.keys()].sort()

  for (const path of written) {
    const target = join(dir, path)
    const fresh = !existsSync(target)

    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, writes.get(path)!, fresh && path === '.env' ? { mode: 0o600 } : {})
  }

  return written
}

export interface AddOptions {
  install?: boolean | undefined
  // The executable that runs `add` and `install`, `bun` itself unless a test stands in for it.
  bun?: string | undefined
}

// Adds the features to the project in `dir`: the files and edits `kay new --with` would have made, then the install. Nothing is written when a file does not have the shape `kay new` writes; the error says what to change by hand.
export async function addFeatures(dir: string, names: readonly string[], options: AddOptions = {}): Promise<AddResult> {
  const unknown = names.find(name => !FEATURE_NAMES.includes(name as Feature) && !Object.hasOwn(LIBRARIES, name))

  if (unknown !== undefined)
    throw new Error(`kay add: ${unknown} is none of the features ${[...FEATURE_NAMES, ...Object.keys(LIBRARIES)].join(', ')}`)

  const core = names.filter((name): name is Feature => FEATURE_NAMES.includes(name as Feature))
  const libraries = names.filter(name => Object.hasOwn(LIBRARIES, name))
  let plan = await planCore(dir, core)

  failIfConflicts(plan)

  if (libraries.length > 0)
    plan = await addLibraries(dir, core, libraries, plan, options)

  const written = await writePlan(dir, plan)
  const install = options.install !== false && (plan.writes.has('package.json') || libraries.length > 0)

  if (install) {
    const done = await spawn([options.bun ?? process.execPath, 'install'], dir)

    if (done.code !== 0)
      throw new Error(`kay add: the files are written, but bun install failed\n${done.output}`)
  }

  return { written, installed: install, notes: plan.notes }
}
