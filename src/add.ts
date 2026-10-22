import type { Feature } from './templates'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'
import { insertImport } from './imports'
import { FEATURE_NAMES, FEATURES, originHost, projectFiles } from './new'

// Files whose lines are a set: a feature adds the lines the file lacks and keeps the rest.
const LINE_FILES = new Set(['.gitignore', '.dockerignore'])
// Files describing the project to agents: rewritten while unedited, left alone once the author wrote in them.
const SOFT_FILES = new Set(['AGENTS.md'])
const CALLEE = /^(\w+)\(/
const KEY = /\bextensions\s*:/
const CLOSED = /^\s*\]/
const DEFINE_CONFIG = /defineConfig\(\{[ \t]*\n?/
const EXTENSIONS = /extensions:\s*\[/
const AUTH_CALL = /\bauth\(/
const NEWLINE = /\r?\n/
const EDGE_SLASHES = /^\/|\/$/g
// A `KEY=value` line of a .env file, with the `export ` some write before it.
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=(.*)$/
const QUOTED = /^(['"])(.*?)\1(?:\s+#.*)?$/
const INLINE_COMMENT = /\s+#.*$/

// A change to a file the project already has, for what a feature cannot write whole: `find` is replaced by `replace` once, an `import` line added where the app's sort puts it. A file missing, or not the shape `find` reads, is left alone and named in the notes; one holding `done` already is left as it is.
export interface LibraryEdit {
  file: string
  find: RegExp
  // A function gets the match and its groups, for an edit whose text depends on the shape it found.
  replace: string | ((match: string, ...groups: string[]) => string)
  done: string
  import?: string | undefined
}

// What a library reads of the project to say what it writes.
export interface LibraryProject {
  // The package.json name.
  name: string
  // Whether a file exists, or an earlier library of the same run writes it.
  exists: (path: string) => boolean
  // A file's text, as it stands or as an earlier library of the same run wrote it.
  read: (path: string) => string | undefined
  // Whether package.json lists the package.
  depends: (name: string) => boolean
}

// What a library says `kay add <name>` writes: its files, and the entry it adds to `extensions` in kay.config.ts. Its `/add` module exports it, or a function of the project returning it.
export interface LibraryFeature {
  description: string
  // Paths relative to the project root, with their content; a file the project has already is left alone when identical and reported otherwise.
  files?: Record<string, string> | undefined
  // Changes to files the project has already.
  edits?: readonly LibraryEdit[] | undefined
  // `KEY=value` lines for .env, the keys it lacks only; the same keys go to .env.example empty.
  env?: Record<string, string> | undefined
  // Keys .env.example lists with no value, for production to set.
  example?: readonly string[] | undefined
  // Lines .gitignore lacks.
  ignore?: readonly string[] | undefined
  // The import line and the expression added to `extensions: [...]`.
  extension?: { import: string, expression: string } | undefined
  // Printed once the feature is added: what the author still has to decide.
  notes?: readonly string[] | undefined
}

// The libraries that register features: `kay add ai` adds their packages, the first of which is asked what to write through its `/add` module. A kayjs package takes kay's own minor, any other the range kay itself uses.
export const LIBRARIES: Record<string, string[]> = {
  ai: ['@kaynooo/kayjs-ai'],
  mail: ['@kaynooo/kayjs-mail'],
  cms: ['@kaynooo/kayjs-cms', '@kaynooo/kayjs-ui', '@iconify-json/tabler'],
  ui: ['@kaynooo/kayjs-ui', '@iconify-json/tabler'],
  auth: ['@kaynooo/kayjs-auth', '@kaynooo/kayjs-ui', '@iconify-json/tabler', '@kaynooo/pg-orm'],
}

// The core features a library needs, and the libraries it brings along: kayjs-auth's pages are drawn with kayjs-ui, which is mounted once for the whole app.
const LIBRARY_NEEDS: Record<string, { features: readonly Feature[], libraries: readonly string[] }> = {
  ui: { features: ['tailwind'], libraries: [] },
  auth: { features: ['server', 'tailwind'], libraries: ['ui'] },
}

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
  const config = await read(join(dir, 'kay.config.ts'))
  const checks: [Feature, boolean][] = [
    ['server', at('src/server.ts')],
    ['starter', at('src/components/header.kay')],
    ['tailwind', css?.includes('@import \'tailwindcss\'') === true],
    ['accents', at('src/theme.ts')],
    ['eslint', at('eslint.config.ts')],
    ['tests', at('bunfig.toml')],
    ['ci', ['.forgejo', '.github'].some(host => at(`${host}/workflows/test.yml`) || at(`${host}/workflows/pages.yml`))],
    ['docker', at('Dockerfile')],
    // kayjs-auth's root guard, over an `auth()` in the config or the `src/auth.ts` of the former form.
    ['auth', at('src/routes/_guard.ts') && (at('src/auth.ts') || AUTH_CALL.test(config ?? ''))],
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

// What a library's extension was called before it was renamed, so a config on the old name is not given the new one beside it.
const FORMER_NAMES: Record<string, string[]> = { auth: ['authPages', 'authExtension'], mail: ['mailExtension'] }

// kay.config.ts with an import and an `extensions` entry added, or undefined when it is not a plain `defineConfig({ ... })` with no `extensions` or a literal list; an extension the config already calls is left as it is.
export function addExtension(config: string, extension: { import: string, expression: string }): string | undefined {
  const define = DEFINE_CONFIG.exec(config)

  if (define === null)
    return undefined

  const callee = (CALLEE).exec(extension.expression)?.[1]

  if (callee !== undefined && [callee, ...FORMER_NAMES[callee] ?? []].some(name => new RegExp(`\\b${name}\\(`).test(config)))
    return config

  const hasKey = KEY.test(config)
  const list = EXTENSIONS.exec(config)

  if (hasKey && list === null)
    return undefined

  const at = list === null ? define.index + define[0].length : list.index + list[0].length
  const empty = list !== null && CLOSED.test(config.slice(at))
  const entry = list === null ? `${define[0].endsWith('\n') ? '' : '\n'}  extensions: [${extension.expression}],\n` : `${extension.expression}${empty ? '' : ', '}`
  const next = `${config.slice(0, at)}${entry}${config.slice(at)}`

  if (extension.import === '' || (callee !== undefined && new RegExp(`import\\s*\\{[^}]*\\b${callee}\\b[^}]*\\}\\s*from`).test(next)))
    return next

  return insertImport(next, extension.import)
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

// The database URL a feature needs: a new .env is written whole, an existing one gets the keys it lacks and a conflict for one set to something else.
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
    else if (unquote(existing[2]!) !== unquote(value!))
      conflicts.push(`.env: ${existing[0].trim()} is not what the feature uses: set ${line} by hand`)
  }

  if (missing.length > 0)
    writes.set('.env', withLines(disk, missing.join('\n')))
}

// What adding the core features changes: the files to write, and the files that are not in the shape `kay new` writes.
// `postgres` keeps kayjs-auth's users, so adding it to a project without kayjs-auth plans its files too, and `kay add auth,postgres` writes them in one run.
async function planCore(dir: string, core: readonly Feature[]): Promise<Plan> {
  const { text, manifest } = await readManifest(dir)
  const kay = manifest.dependencies?.kay

  if (kay === undefined)
    throw new Error('kay add: package.json has no kay dependency, so this is not a kay project')

  const plan: Plan = { writes: new Map(), conflicts: [], notes: [] }

  if (core.length === 0)
    return plan

  const current = await detectFeatures(dir)

  if (core.every(feature => current.has(feature)))
    return plan

  const wanted = new Set([...current, ...core])
  const implied = wanted.has('postgres') && !wanted.has('auth') && !current.has('postgres') && manifest.dependencies?.['@kaynooo/kayjs-auth'] === undefined

  if (implied)
    wanted.add('auth')

  for (const feature of core) {
    // postgres plans the members itself, or has them in kayjs-auth's database.
    const missing = FEATURES[feature].needs.filter(need => !wanted.has(need) && !(feature === 'postgres' && need === 'auth'))

    if (missing.length > 0)
      throw new Error(`kay add: ${feature} needs ${missing.join(' and ')}: run \`kay add ${[...missing, feature].join(',')}\` to add them together`)
  }

  for (const need of implied ? ['server', 'tailwind'] as const : []) {
    if (!wanted.has(need))
      throw new Error(`kay add: postgres brings kayjs-auth, which needs ${need}: run \`kay add ${need},postgres\` to add them together`)
  }

  const { writes, conflicts, notes } = plan
  // The project may have been renamed since `kay new` named its package after the directory, so the templates take its own name.
  const named = join(dirname(dir), manifest.name ?? basename(dir))
  const host = await hostOf(dir)
  const runner = await runnerOf(dir, host)

  // kayjs-auth's SQLite file holds users that Postgres would leave behind.
  if (core.includes('postgres') && current.has('auth') && existsSync(join(dir, 'data/auth.db')))
    conflicts.push('data/auth.db holds the users postgres would leave behind: move them to Postgres, or delete the file to start with none, then run this again')

  const [old, next] = await Promise.all([projectFiles(named, current, kay, {}, host, runner), projectFiles(named, wanted, kay, {}, host, runner)])

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

// A bare, quoted or single-item flow sequence label, then an optional comment: `docker`, `"docker"`, `[docker]`, `docker # self-hosted`.
const RUNS_ON = /^\s+runs-on:[ \t]*(?:\[[ \t]*)?(?:"([\w.:-]+)"|'([\w.:-]+)'|([\w.:-]+))(?:[ \t]*\])?[ \t]*(?:#.*)?$/m

// The runner label the project's workflows run on, which `kay new --runner` may have set: the first `runs-on` of its test or pages workflow, else the host's own.
export async function runnerOf(dir: string, host: 'github' | 'forgejo'): Promise<string | undefined> {
  for (const name of ['test', 'pages']) {
    const workflow = await read(join(dir, `.${host}/workflows/${name}.yml`))
    const found = workflow?.match(RUNS_ON)
    const label = found?.[1] ?? found?.[2] ?? found?.[3]

    if (label !== undefined)
      return label
  }

  return undefined
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

async function loadLibrary(dir: string, name: string, project: LibraryProject): Promise<LibraryFeature> {
  let path: string

  try {
    path = Bun.resolveSync(`${LIBRARIES[name]![0]!}/add`, dir)
  }
  catch {
    throw new Error(`kay add: ${LIBRARIES[name]![0]!} is not installed, and --no-install or --dry-run keeps kay add from installing it: it has to be installed to say what it writes`)
  }

  const module = await import(path) as { default?: LibraryFeature | ((project: LibraryProject) => LibraryFeature) }
  const feature = typeof module.default === 'function' ? module.default(project) : module.default

  if (typeof feature?.description !== 'string')
    throw new Error(`kay add: ${LIBRARIES[name]![0]!}/add does not export a feature as its default`)

  return feature
}

function failIfConflicts({ conflicts }: Plan): void {
  if (conflicts.length > 0)
    throw new Error(`kay add: nothing was written\n\n${conflicts.join('\n\n')}`)
}

// Packages `kay new` lists under devDependencies.
const DEV_PACKAGES = new Set(['@iconify-json/tabler'])

// The range a kayjs package is installed at (kay's own minor), any other at the range kay uses.
async function packageRange(name: string): Promise<string> {
  const own = JSON.parse(await readFile(join(import.meta.dir, '../package.json'), 'utf8')) as { version: string, devDependencies: Record<string, string> }

  return name.startsWith('@kaynooo/kayjs-') ? `~${own.version}` : own.devDependencies[name]!
}

// Installs what the libraries need and the project lacks: a kayjs package at kay's own minor, any other at the range kay uses, the dev ones in a call of their own.
async function installPackages(dir: string, missing: readonly string[], bun: string): Promise<void> {
  const ranges = new Map(await Promise.all(missing.map(async name => [name, await packageRange(name)] as const)))
  const spec = (name: string) => `${name}@${ranges.get(name)!}`

  for (const [flags, names] of [[[], missing.filter(name => !DEV_PACKAGES.has(name))], [['-d'], missing.filter(name => DEV_PACKAGES.has(name))]] as const) {
    if (names.length === 0)
      continue

    const added = await spawn([bun, 'add', ...flags, ...names.map(spec)], dir)

    if (added.code !== 0)
      throw new Error(`kay add: bun add failed, nothing was written\n${added.output}`)
  }
}

// What the project holds for a library to read: the files on disk, as an earlier library of the run is about to change them.
async function projectOf(dir: string, plan: Plan, onDiskManifest: Manifest): Promise<LibraryProject> {
  const planned = plan.writes.get('package.json')
  const manifest = planned === undefined ? onDiskManifest : JSON.parse(planned) as Manifest
  const held = new Map<string, string | undefined>()

  for (const path of ['src/db/index.ts', 'src/mail.ts', '.env', '.env.example'])
    held.set(path, await read(join(dir, path)))

  const onDisk = (path: string) => existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : undefined
  const text = (path: string) => plan.writes.get(path) ?? (held.has(path) ? held.get(path) : onDisk(path))

  return {
    name: manifest.name ?? basename(dir),
    exists: path => plan.writes.has(path) || existsSync(join(dir, path)),
    read: text,
    depends: name => manifest.dependencies?.[name] !== undefined || manifest.devDependencies?.[name] !== undefined,
  }
}

// `.env.example` with the keys it lacks, empty.
function mergeExample(disk: string | undefined, keys: readonly string[], plan: Plan): void {
  const have = new Set((disk ?? '').split(NEWLINE).map(line => ENV_LINE.exec(line)?.[1]))
  const missing = keys.filter(key => !have.has(key))

  if (missing.length > 0)
    plan.writes.set('.env.example', withLines(plan.writes.get('.env.example') ?? disk ?? '', missing.map(key => `${key}=`).join('\n')))
}

// `String.replace` takes the string or the function, and not the union of both.
function replaced(text: string, { find, replace }: LibraryEdit): string {
  return typeof replace === 'string' ? text.replace(find, replace) : text.replace(find, replace)
}

function applyEdit(edit: LibraryEdit, library: string, plan: Plan, text: string | undefined): void {
  if (text?.includes(edit.done) === true)
    return

  const changed = text === undefined || !edit.find.test(text) ? undefined : replaced(text, edit)

  if (changed === undefined) {
    plan.notes.push(`${edit.file} is not the shape ${library} edits: add \`${edit.done}\` to it by hand`)

    return
  }

  plan.writes.set(edit.file, edit.import === undefined ? changed : insertImport(changed, edit.import))
}

// Asks each installed library what it writes, adding its files, its changes, its extension and its notes to the plan.
async function planLibraries(dir: string, libraries: readonly string[], plan: Plan): Promise<void> {
  const { manifest: onDiskManifest } = await readManifest(dir)

  for (const library of libraries) {
    const project = await projectOf(dir, plan, onDiskManifest)
    const feature = await loadLibrary(dir, library, project)

    for (const [path, content] of Object.entries(feature.files ?? {})) {
      const disk = await read(join(dir, path))

      if (disk === undefined)
        plan.writes.set(path, content)
      else if (disk !== content)
        plan.conflicts.push(`${path} exists and is not the file ${library} writes: add\n${handEdit(disk, content)}`)
    }

    for (const edit of feature.edits ?? [])
      applyEdit(edit, library, plan, project.read(edit.file))

    if (feature.env !== undefined)
      mergeEnv(project.read('.env'), Object.entries(feature.env).map(([key, value]) => `${key}=${value}`).join('\n'), plan)

    if (feature.env !== undefined || feature.example !== undefined)
      mergeExample(project.read('.env.example'), [...Object.keys(feature.env ?? {}), ...feature.example ?? []], plan)

    if (feature.ignore !== undefined) {
      const ignored = project.read('.gitignore') ?? ''
      // A folder written `/data` or `data/` is as ignored as `data`.
      const have = new Set(ignored.split(NEWLINE).map(line => line.replace(EDGE_SLASHES, '')))
      const merged = withLines(ignored, feature.ignore.filter(line => !have.has(line)).join('\n'))

      if (merged !== ignored)
        plan.writes.set('.gitignore', merged)
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

    if (missing.length > 0 && options.install !== false && options.dryRun !== true) {
      await installPackages(dir, missing, options.bun ?? process.execPath)

      // The package.json changed on disk, so the merge starts over from it.
      next = await planCore(dir, core)
      failIfConflicts(next)
    }

    // A dry run installs nothing, so the plan names the dependencies the install would add.
    if (missing.length > 0 && options.dryRun === true) {
      const current = JSON.parse(next.writes.get('package.json') ?? (await readManifest(dir)).text) as Manifest

      for (const name of missing) {
        const group = DEV_PACKAGES.has(name) ? 'devDependencies' : 'dependencies'

        current[group] = { ...current[group], [name]: await packageRange(name) }
      }

      next.writes.set('package.json', `${JSON.stringify(current, null, 2)}\n`)
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
  // Plans the files and notes without writing or installing anything, so a library has to be installed already to be planned.
  dryRun?: boolean | undefined
  install?: boolean | undefined
  // The executable that runs `add` and `install`, `bun` itself unless a test stands in for it.
  bun?: string | undefined
}

// The libraries with the ones they bring along, each once, a library after those it brings.
function withBrought(libraries: readonly string[]): string[] {
  const all = [...new Set(libraries.flatMap(library => [...LIBRARY_NEEDS[library]?.libraries ?? [], library]))]

  // The mail library goes first: kayjs-auth wires its mailer when src/mail.ts exists.
  return [...all.filter(library => library === 'mail'), ...all.filter(library => library !== 'mail')]
}

// A library needing a core feature the project lacks is refused naming the command that adds them together.
async function requireFeatures(dir: string, core: readonly Feature[], libraries: readonly string[]): Promise<void> {
  const wanted = new Set([...await detectFeatures(dir), ...core])

  for (const library of libraries) {
    const missing = (LIBRARY_NEEDS[library]?.features ?? []).filter(need => !wanted.has(need))

    if (missing.length > 0)
      throw new Error(`kay add: ${library} needs ${missing.join(' and ')}: run \`kay add ${[...missing, library].join(',')}\` to add them together`)
  }
}

// Adds the features to the project in `dir`: the files and edits `kay new --with` would have made, then the install. Nothing is written when a file does not have the shape `kay new` writes; the error says what to change by hand.
export async function addFeatures(dir: string, names: readonly string[], options: AddOptions = {}): Promise<AddResult> {
  const unknown = names.find(name => !FEATURE_NAMES.includes(name as Feature) && !Object.hasOwn(LIBRARIES, name))

  if (unknown !== undefined)
    throw new Error(`kay add: ${unknown} is none of the features ${[...FEATURE_NAMES, ...Object.keys(LIBRARIES)].join(', ')}`)

  // A library's name wins over a core feature's: `auth` is kayjs-auth.
  const core = names.filter((name): name is Feature => FEATURE_NAMES.includes(name as Feature) && !Object.hasOwn(LIBRARIES, name))
  const libraries = withBrought(names.filter(name => Object.hasOwn(LIBRARIES, name)))
  let plan = await planCore(dir, core)

  failIfConflicts(plan)
  await requireFeatures(dir, core, libraries)

  if (libraries.length > 0)
    plan = await addLibraries(dir, core, libraries, plan, options)

  const written = options.dryRun === true ? [...plan.writes.keys()].sort() : await writePlan(dir, plan)
  const install = options.install !== false && options.dryRun !== true && (plan.writes.has('package.json') || libraries.length > 0)

  if (install) {
    const done = await spawn([options.bun ?? process.execPath, 'install'], dir)

    if (done.code !== 0)
      throw new Error(`kay add: the files are written, but bun install failed\n${done.output}`)
  }

  return { written, installed: install, notes: plan.notes }
}
