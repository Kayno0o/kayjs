import type { Feature } from './templates'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { detectHost, FEATURE_NAMES, FEATURES, projectFiles } from './new'

// Files whose lines are a set: a feature adds the lines the file lacks and keeps the rest.
const LINE_FILES = new Set(['.gitignore', '.dockerignore'])
// Files describing the project to agents: rewritten while unedited, left alone once the author wrote in them.
const SOFT_FILES = new Set(['AGENTS.md'])
const IMPORTS = /^(?:import\b.*\n)*/
const DEFINE_CONFIG = /defineConfig\(\{[ \t]*\n?/
const EXTENSIONS = /extensions:\s*\[/
const NEWLINE = /\r?\n/

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

// The lines a hand edit has to remove and add to turn `from` into `to`, compared as sets of lines.
function handEdit(from: string, to: string): string {
  const before = new Set(from.split(NEWLINE))
  const after = new Set(to.split(NEWLINE))
  const removed = [...before].filter(line => !after.has(line) && line.trim() !== '').map(line => `-${line}`)
  const added = [...after].filter(line => !before.has(line) && line.trim() !== '').map(line => `+${line}`)

  return [...removed, ...added].join('\n')
}

// `current` with the lines of `wanted` it lacks at the end.
function withLines(current: string, wanted: string): string {
  const have = new Set(current.split(NEWLINE))
  const missing = wanted.split(NEWLINE).filter(line => line !== '' && !have.has(line))

  if (missing.length === 0)
    return current

  return `${current === '' || current.endsWith('\n') ? current : `${current}\n`}${missing.join('\n')}\n`
}

// kay.config.ts with an import and an `extensions` entry added, or undefined when it holds no plain `defineConfig({ ... })`.
export function addExtension(config: string, extension: { import: string, expression: string }): string | undefined {
  if (extension.expression !== '' && config.includes(extension.expression))
    return config

  const define = DEFINE_CONFIG.exec(config)

  if (define === null)
    return undefined

  const list = EXTENSIONS.exec(config)
  const at = list === null ? define.index + define[0].length : list.index + list[0].length
  const entry = list === null ? `  extensions: [${extension.expression}],\n` : `${extension.expression}, `
  const next = `${config.slice(0, at)}${entry}${config.slice(at)}`

  if (extension.import === '' || next.includes(extension.import))
    return next

  const head = IMPORTS.exec(next)![0]

  return `${next.slice(0, head.length)}${extension.import}\n${next.slice(head.length)}`
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

  const keyOf = (line: string) => line.slice(0, line.indexOf('='))
  const have = new Map(disk.split(NEWLINE).filter(line => line.includes('=')).map(line => [keyOf(line), line] as const))
  const missing: string[] = []

  for (const line of content.split(NEWLINE).filter(entry => entry.includes('='))) {
    const existing = have.get(keyOf(line))

    if (existing === undefined)
      missing.push(line)
    else if (existing !== line && keyOf(line) !== 'SESSION_SECRET')
      conflicts.push(`.env: ${existing} is not what the feature uses: set ${line} by hand`)
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

  const plan: Plan = { writes: new Map(), conflicts: [] }

  if (core.length === 0)
    return plan

  const current = await detectFeatures(dir)
  const wanted = new Set([...current, ...core])

  for (const feature of core) {
    const missing = FEATURES[feature].needs.filter(need => !wanted.has(need))

    if (missing.length > 0)
      throw new Error(`kay add: ${feature} needs ${missing.join(' and ')}: run \`kay add ${[...missing, feature].join(',')}\` to add them together`)
  }

  const { writes, conflicts } = plan
  // The project may have been renamed since `kay new` named its package after the directory, so the templates take its own name.
  const named = join(dirname(dir), manifest.name ?? basename(dir))
  const host = existsSync(join(dir, '.github/workflows')) ? 'github' : await detectHost(dir)
  const [old, next] = await Promise.all([projectFiles(named, current, kay, {}, host), projectFiles(named, wanted, kay, {}, host)])

  for (const [path, content] of Object.entries(next)) {
    const disk = await read(join(dir, path))
    const was = old[path]

    if (path === 'package.json') {
      const merged = `${JSON.stringify(mergeManifest(manifest, JSON.parse(was!) as Manifest, JSON.parse(content) as Manifest, conflicts), null, 2)}\n`

      if (merged !== text)
        writes.set(path, merged)
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
      else if (disk !== undefined && !SOFT_FILES.has(path))
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

async function loadLibrary(dir: string, name: string): Promise<LibraryFeature> {
  const module = await import(Bun.resolveSync(`${LIBRARIES[name]![0]!}/add`, dir)) as { default?: LibraryFeature }

  if (typeof module.default?.description !== 'string')
    throw new Error(`kay add: ${LIBRARIES[name]![0]!}/add does not export a feature as its default`)

  return module.default
}

function failIfConflicts({ conflicts }: Plan, added = ''): void {
  if (conflicts.length > 0)
    throw new Error(`kay add: ${added}nothing was written\n\n${conflicts.join('\n\n')}`)
}

// Adds the features to the project in `dir`: the files and edits `kay new --with` would have made, then the install. Nothing is written when a file does not have the shape `kay new` writes; the error says what to change by hand.
// A library is added to the package.json first, as it cannot be asked what to write before it is installed.
export async function addFeatures(dir: string, names: readonly string[], options: { install?: boolean | undefined } = {}): Promise<AddResult> {
  const unknown = names.find(name => !FEATURE_NAMES.includes(name as Feature) && !(name in LIBRARIES))

  if (unknown !== undefined)
    throw new Error(`kay add: ${unknown} is none of the features ${[...FEATURE_NAMES, ...Object.keys(LIBRARIES)].join(', ')}`)

  const core = names.filter((name): name is Feature => FEATURE_NAMES.includes(name as Feature))
  const libraries = names.filter(name => name in LIBRARIES)
  const notes: string[] = []
  let plan = await planCore(dir, core)

  failIfConflicts(plan)

  if (libraries.length > 0) {
    const config = plan.writes.get('kay.config.ts') ?? await read(join(dir, 'kay.config.ts'))

    if (config === undefined || addExtension(config, { import: '', expression: '' }) === undefined)
      throw new Error('kay add: nothing was written\n\nkay.config.ts has no `defineConfig({ ... })` to add an extension to: add it to `extensions` by hand')

    const { manifest } = await readManifest(dir)
    const missing = libraries.flatMap(library => LIBRARIES[library]!).filter(name => manifest.dependencies?.[name] === undefined && manifest.devDependencies?.[name] === undefined)

    if (missing.length > 0 && options.install !== false) {
      const own = JSON.parse(await readFile(join(import.meta.dir, '../package.json'), 'utf8')) as { version: string, devDependencies: Record<string, string> }
      const added = await spawn([process.execPath, 'add', ...missing.map(name => name.startsWith('@kaynooo/kayjs-') ? `${name}@~${own.version}` : `${name}@${own.devDependencies[name]!}`)], dir)

      if (added.code !== 0)
        throw new Error(`kay add: bun add failed, nothing was written\n${added.output}`)

      // The package.json changed on disk, so the merge starts over from it.
      plan = await planCore(dir, core)
      failIfConflicts(plan, `${missing.join(' and ')} was added to package.json, but `)
    }

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

      notes.push(...feature.notes ?? [])
    }

    failIfConflicts(plan, `${libraries.join(' and ')} is in package.json, but `)
  }

  const written = [...plan.writes.keys()].sort()

  for (const path of written) {
    const target = join(dir, path)
    const fresh = !existsSync(target)

    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, plan.writes.get(path)!)

    // The session secret is for its owner's eyes only: a file just made takes the mode.
    if (path === '.env' && fresh)
      await chmod(target, 0o600)
  }

  const install = options.install !== false && (plan.writes.has('package.json') || libraries.length > 0)

  if (install) {
    const done = await spawn([process.execPath, 'install'], dir)

    if (done.code !== 0)
      throw new Error(`kay add: the files are written, but bun install failed\n${done.output}`)
  }

  return { written, installed: install, notes }
}
