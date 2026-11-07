import type { ConfigSettings, Feature, Host } from './templates'
import { existsSync, statSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { checklist, select } from '@kaynooo/cli-kit/prompt'
import { addFeatures, LibraryNotInstalledError } from './add'
import { nativeExe } from './compiler/native-typescript'
import { FEATURE_NAMES, FEATURES } from './features'
import { AGENT_FILES, agentsFile, CLAUDE_FILE, MCP_FILE, templateFiles } from './templates'

// The kay this command runs from: a git checkout, which a new project depends on a packed copy of, or the published package.
const KAY_ROOT = resolve(import.meta.dir, '..')
const INVALID_NAME_CHARS = /[^a-z0-9._~-]+/g
const NAME_EDGES = /^[-._~]+|[-._~]+$/g
const NAME_TAIL = /[^a-z0-9]+/i
const SCOPE = /^@[^/]+\//

export const GITHUB_REMOTE = /(?:@|\/\/)github\.com[:/]/

const RUNNER_LABEL = /^[\w.:-]+$/

export const HOSTS: readonly Host[] = ['forgejo', 'github']

export { FEATURE_NAMES, FEATURES }
export type { Feature, Host }

export type Preset = 'blank' | 'server' | 'site' | 'app'

const SITE: readonly Feature[] = ['starter', 'tailwind', 'accents', 'eslint', 'tests', 'ci', 'docker']

export const PRESETS: Record<Preset, { description: string, features: readonly Feature[] }> = {
  blank: { description: 'one bare page and nothing else', features: [] },
  server: { description: 'an Elysia server run as one executable, styled, linted, tested and containerised', features: ['server', ...SITE] },
  site: { description: 'the same as a static site, published to Pages or served by nginx', features: SITE },
  app: { description: 'the server, plus kayjs-auth sign-in and a websocket island', features: ['server', ...SITE, 'auth', 'ws'] },
}

export const PRESET_NAMES = Object.keys(PRESETS) as Preset[]

// The `kay` dependency a dry run lists files with, so it never packs a checkout of kay into `vendor`.
export const DRY_RUN_KAY = 'dry-run'

export interface NewOptions {
  // The \`kay\` dependency: by default the published kay running this command, or a packed copy of the checkout running it.
  kay?: string | undefined
  // What the project holds, the `server` preset's by default; each feature's needs must be among them.
  features?: readonly Feature[] | undefined
  // Where the repository lives, which decides the CI's format: Forgejo by default.
  host?: Host | undefined
  // The label of the runner the CI jobs run on, the host's own image by default: `debian` on Forgejo, `ubuntu-latest` on GitHub.
  runner?: string | undefined
  // Writes AGENTS.md, CLAUDE.md and .mcp.json, `false` leaving the three out.
  agents?: boolean | undefined
  // Lists the files without writing any, nor packing a checkout of kay into `vendor`.
  dryRun?: boolean | undefined
  // Installs the packages of the library features (`kay add`'s install), which a test turns off.
  install?: boolean | undefined
  // The executable that installs them, `bun` itself unless a test stands in for it.
  bun?: string | undefined
  // Where a dry run finds the libraries' `add` exports, kay's own folder unless a test points it elsewhere.
  librariesFrom?: string | undefined
  // Receives what the library features say the author still has to decide, as `kay add` prints it.
  notes?: string[] | undefined
}

// What checking or unchecking a feature leaves checked: checking takes what it needs along, unchecking drops what needs it.
export function toggle(features: ReadonlySet<Feature>, feature: Feature): ReadonlySet<Feature> {
  const next = new Set(features)
  const check = (name: Feature) => {
    next.add(name)

    for (const need of [...FEATURES[name].needs, ...FEATURES[name].brings ?? []])
      check(need)
  }
  const uncheck = (name: Feature) => {
    next.delete(name)

    for (const other of FEATURE_NAMES) {
      if (next.has(other) && (FEATURES[other].needs.includes(name) || FEATURES[other].brings?.includes(name)))
        uncheck(other)
    }
  }

  if (next.has(feature))
    uncheck(feature)
  else
    check(feature)

  return next
}

// Asks on the terminal for a preset, then for its features one by one; undefined once the user cancels.
export async function pickFeatures(): Promise<Feature[] | undefined> {
  const preset = await select('Start from', PRESET_NAMES.map(name => ({ value: name, label: name, hint: PRESETS[name].description })), { initial: PRESET_NAMES.indexOf('server') })

  if (preset === undefined)
    return undefined

  const features = await checklist('Features', FEATURE_NAMES.map(name => ({ value: name, label: name, hint: FEATURES[name].description })), { initial: new Set(PRESETS[preset].features), toggle })

  return features && FEATURE_NAMES.filter(name => features.has(name))
}

// GitHub when the `origin` remote of the target, or of the nearest directory above it that exists, is on github.com, else Forgejo: a project made in a fresh directory inside a clone takes the clone's host.
export async function detectHost(target: string): Promise<Host> {
  let dir = resolve(target)

  while (!existsSync(dir) && dirname(dir) !== dir)
    dir = dirname(dir)

  return await originHost(dir) ?? 'forgejo'
}

// The host the `origin` remote of `dir` is on, or nothing when it has none or git cannot be run.
export async function originHost(dir: string): Promise<Host | undefined> {
  try {
    const git = Bun.spawn(['git', '-C', dir, 'remote', 'get-url', 'origin'], { stdout: 'pipe', stderr: 'ignore' })
    const [url, code] = await Promise.all([new Response(git.stdout).text(), git.exited])

    if (code !== 0)
      return undefined

    return GITHUB_REMOTE.test(url) ? 'github' : 'forgejo'
  }
  catch {
    return undefined
  }
}

// Refuses a target `kay new` would write over: a file, or a directory that already holds files.
export async function refuseTarget(target: string): Promise<void> {
  const dir = resolve(target)

  if (existsSync(dir) && !statSync(dir).isDirectory())
    throw new Error(`kay: ${target} is not a directory`)

  if (existsSync(dir) && (await readdir(dir)).length > 0)
    throw new Error(`kay: ${target} is not empty`)
}

// Whether `kay new` adds the feature through `kay add` after scaffolding: a library's, but for a templated one whose files the templates write.
export function libraryFeature(name: Feature): boolean {
  return FEATURES[name].packages !== undefined && FEATURES[name].templated !== true
}

// Scaffolds a project that \`kay dev\` runs and \`kay check\` passes as it is; refuses a directory that already holds files.
export async function createProject(target: string, options: NewOptions = {}): Promise<string[]> {
  const dir = resolve(target)
  const features = new Set(options.features ?? PRESETS.server.features)
  const libraries = FEATURE_NAMES.filter(name => features.has(name) && libraryFeature(name))

  for (const feature of features) {
    const missing = FEATURES[feature].needs.filter(need => !features.has(need))

    if (missing.length > 0)
      throw new Error(`kay: ${feature} needs ${missing.join(' and ')}: add --with ${missing.join(',')}, or drop it with --without ${feature}`)
  }

  if (options.runner !== undefined && !RUNNER_LABEL.test(options.runner))
    throw new Error(`kay new: --runner is ${JSON.stringify(options.runner)}, which is no runner label: it takes letters, digits and - _ . : only`)

  await refuseTarget(target)

  const files = await projectFiles(dir, features, options.kay ?? (options.dryRun === true ? DRY_RUN_KAY : undefined), {}, options.host, options.runner)

  if (options.agents === false) {
    for (const path of AGENT_FILES)
      delete files[path]
  }

  if (options.dryRun === true)
    return [...new Set([...Object.keys(files), ...await librariesDryRun(files, libraries, options)])].sort()

  // The database credentials in .env are for its owner's eyes only from the moment it is written, which Bun.write cannot do as it ignores a mode.
  await mkdir(dir, { recursive: true })
  await Promise.all(Object.entries(files).map(async ([path, content]) => path === '.env' ? writeFile(join(dir, path), content, { mode: 0o600 }) : Bun.write(join(dir, path), content)))

  if (libraries.length === 0)
    return Object.keys(files).sort()

  // The same run as `kay add` on the project just written, which installs the libraries before it can ask them what they write.
  let added: Awaited<ReturnType<typeof addFeatures>>

  try {
    added = await addFeatures(dir, libraries, { install: options.install, bun: options.bun })
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    throw new Error(`kay new: the project is written in ${target}, but adding ${libraries.join(', ')} failed: ${message}\n\nFinish with \`cd ${target} && kay add ${libraries.join(',')}\``, { cause: error })
  }

  options.notes?.push(...added.notes)

  return [...new Set([...Object.keys(files), ...added.written])].sort()
}

// The files the library features would write on top of `files`, planned in a scratch copy of the project: nothing is installed, so the libraries are read from beside kay.
async function librariesDryRun(files: Record<string, string>, libraries: readonly Feature[], options: NewOptions): Promise<string[]> {
  if (libraries.length === 0)
    return []

  const scratch = await mkdtemp(join(tmpdir(), 'kay-new-'))

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(scratch, path), content)))

    const planned = await addFeatures(scratch, libraries, { dryRun: true, resolveFrom: options.librariesFrom ?? KAY_ROOT })

    options.notes?.push(...planned.notes)

    return planned.written
  }
  catch (error) {
    if (!(error instanceof LibraryNotInstalledError))
      throw error

    options.notes?.push(`${libraries.join(', ')} ${libraries.length === 1 ? 'is' : 'are'} not installed beside kay, so the files they write are not listed: they are planned when kay new installs them.`)

    return []
  }
  finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

// Every file of a project with these features in `dir`, named after it; run from a checkout of kay, packs it into `dir/vendor` for the project to depend on.
export async function projectFiles(dir: string, features: ReadonlySet<Feature>, kayDependency?: string | undefined, settings: ConfigSettings = {}, host?: Host, runner?: string): Promise<Record<string, string>> {
  const has = (feature: Feature) => features.has(feature)
  const name = packageName(basename(dir))
  const kay = await Bun.file(join(KAY_ROOT, 'package.json')).json() as { name: string, version: string, dependencies: Record<string, string>, devDependencies: Record<string, string> }
  // A kay minor may break, so the project takes its patches only.
  const dependency = kayDependency ?? (existsSync(join(KAY_ROOT, '.git')) ? await packKay(join(dir, 'vendor')) : `npm:${kay.name}@~${kay.version}`)
  const scripts = {
    'dev': 'kay dev',
    ...has('server') ? { build: 'kay build', compile: 'kay build --compile server', start: 'kay start' } : { build: 'kay build --static' },
    'check': 'kay check',
    ...has('eslint') && { 'lint': 'kay lint --cache', 'lint:fix': 'kay lint --fix --cache' },
    'fmt': 'kay fmt',
    'fmt:check': 'kay fmt --check',
    ...has('tests') && { test: 'kay test' },
    ...has('postgres') && { 'db:generate': 'pg-orm generate', 'db:migrate': 'pg-orm apply' },
  }
  const devDependencies = [
    (has('starter') || has('accents') || has('auth')) && '@iconify-json/tabler',
    has('eslint') && '@kaynooo/eslint',
    '@types/bun',
    ...has('tailwind') ? ['bun-plugin-tailwind', 'tailwindcss'] : [],
  ].filter(entry => entry !== false)
  const files: Record<string, string> = {
    ...templateFiles(features, settings, host, runner),
    'AGENTS.md': agentsFile(scripts, settings.seo !== false),
    'CLAUDE.md': CLAUDE_FILE,
    '.mcp.json': MCP_FILE,
    'package.json': `${JSON.stringify({
      name,
      type: 'module',
      private: true,
      scripts,
      dependencies: { ...has('auth') && { '@kaynooo/kayjs-auth': `~${kay.version}`, '@kaynooo/kayjs-ui': `~${kay.version}`, '@kaynooo/pg-orm': kay.devDependencies['@kaynooo/pg-orm'] }, elysia: kay.dependencies.elysia, kay: dependency },
      devDependencies: Object.fromEntries(devDependencies.map(dev => [dev, kay.devDependencies[dev]!])),
    }, null, 2)}\n`,
    'tsconfig.json': `${JSON.stringify({ extends: 'kay/tsconfig.json' }, null, 2)}\n`,
  }

  // The development database, never committed. With Postgres the app connects as app_rw, which cannot change the schema, and the migrations as the owner; COMPOSE_FILE makes a bare `docker compose` start that database.
  if (has('postgres'))
    files['.env'] = `DATABASE_URL=postgres://app_rw:app_rw@127.0.0.1:5433/app\nMIGRATE_DATABASE_URL=postgres://app:app@127.0.0.1:5433/app\nCOMPOSE_FILE=compose.dev.yaml\n`

  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, content.replaceAll('__NAME__', name).replaceAll('__SITE__', siteName(name))]))
}

// The site's name for mails and authenticator apps, as kayjs-auth's `kay add` words it: the package name in capitals.
function siteName(name: string): string {
  return name.replace(SCOPE, '').split(NAME_TAIL).filter(word => word !== '').map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ') || 'My site'
}

// What a directory name becomes as a package name, which is also safe to write into a template: lower case letters, digits and `-._~`.
function packageName(directory: string): string {
  return directory.toLowerCase().replace(INVALID_NAME_CHARS, '-').replace(NAME_EDGES, '') || 'app'
}

// A packed copy installs like a published package, its dependencies only; a `file:` folder would drag in its devDependencies too.
// Built and packed from a copy beside the checkout, never in it: `prepack` writing types and dist into the checkout would shadow src for every process type-checking or walking it meanwhile.
async function packKay(vendor: string): Promise<string> {
  const manifest = await Bun.file(join(KAY_ROOT, 'package.json')).json() as { files: string[], devDependencies?: unknown, workspaces?: unknown }
  const stage = await mkdtemp(join(tmpdir(), 'kay-pack-'))

  try {
    // Without the workspace libraries, whose versions only an install of the checkout resolves, and which installing kay never reads.
    delete manifest.devDependencies
    delete manifest.workspaces
    await Bun.write(join(stage, 'package.json'), JSON.stringify(manifest, null, 2))
    await Promise.all(manifest.files.filter(entry => entry !== 'types' && entry !== 'dist').map(async entry => cp(join(KAY_ROOT, entry), join(stage, entry), { recursive: true })))

    // Declarations only, unchecked: `bun run check` and `build:types` check the same sources, and a full check here is one more tsgo of about 900 MB.
    const types = Bun.spawn([nativeExe(), '-p', join(KAY_ROOT, 'tsconfig.build.json'), '--outDir', join(stage, 'types'), '--noCheck'], { stdout: 'pipe', stderr: 'pipe' })
    const [typeErrors, typeWarnings, typesCode, processor] = await Promise.all([new Response(types.stdout).text(), new Response(types.stderr).text(), types.exited, Bun.build({ entrypoints: [join(KAY_ROOT, 'src/eslint/index.ts')], target: 'node', packages: 'external', outdir: join(stage, 'dist'), naming: 'eslint.js' })])

    if (typesCode !== 0 || !processor.success)
      throw new Error(`kay: packing ${KAY_ROOT} failed\n${typeErrors}${typeWarnings}${processor.logs.join('\n')}`)

    // tsgo points each declaration map at the checkout's sources; the package ships its own beside the types, as prepack's maps say.
    for (const name of new Bun.Glob('**/*.d.ts.map').scanSync(join(stage, 'types'))) {
      const path = join(stage, 'types', name)
      const map = await Bun.file(path).json() as { sources: string[] }

      map.sources = map.sources.map(source => relative(dirname(path), join(stage, relative(KAY_ROOT, resolve(dirname(path), source)))))
      await Bun.write(path, JSON.stringify(map))
    }

    const child = Bun.spawn([process.execPath, 'pm', 'pack', '--quiet', '--ignore-scripts', '--destination', vendor], { cwd: stage, stdout: 'pipe', stderr: 'pipe' })
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    if (code !== 0)
      throw new Error(`kay: packing ${KAY_ROOT} failed\n${errors}`)

    return `file:./vendor/${basename(output.trim())}`
  }
  finally {
    await rm(stage, { recursive: true, force: true })
  }
}
