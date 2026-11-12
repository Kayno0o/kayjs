import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { $, Glob } from 'bun'
import { PEERS, peerSpec } from '../src/peers'

// `bun scripts/apps-ci.ts pack` packs kay and each library into KAY_APPS_DIR, `bun scripts/apps-ci.ts <app>...` clones each app, installs it against those tarballs and runs its own check, lint and test scripts: what the Apps workflow runs before a release.
export interface App {
  name: string
  // The Forgejo repository, owner/name.
  repo: string
  // A branch that is not the repository's default.
  branch?: string
  // The folder holding the lockfile the app installs from, relative to the repository root; the root by default.
  install?: string
  // The packages whose scripts run, relative to the install folder; it alone by default, or 'workspaces' for each workspace of its package.json that has a check, lint or test script.
  dirs?: string[] | 'workspaces'
  // Files the repository keeps out of git and its checks read (a compose file's env_file), written empty at these paths from the repository root.
  stubs?: string[]
  // A script that cannot run in CI, with the reason it prints instead.
  skip?: Partial<Record<Script, string>>
}

export type Script = typeof SCRIPTS[number]

export const SCRIPTS = ['check', 'lint', 'test'] as const

const COMPOSE = 'needs the compose stack of its own test database'
const ORBIT_DATABASE = 'needs a database and services only its compose files start'

// The apps of the `kay-sites` memory that have a remote (kay-mail-test has none), with enshrouded's dashboard and mc-stats, which pin kay too; relay/auth is not an orbit workspace, so it installs on its own.
export const APPS: App[] = [
  { name: 'kaynooo.fr', repo: 'kaynooo/kaynooo.fr', skip: { test: COMPOSE } },
  { name: 'kloe-couture', repo: 'kaynooo/kloecouture', skip: { test: COMPOSE } },
  { name: 'jb-peinture', repo: 'kaynooo/jb-peinture' },
  { name: 'cromignon24', repo: 'kaynooo/cromignon24' },
  { name: 'devlog', repo: 'kaynooo/devlog' },
  { name: 'babelraid', repo: 'kaynooo/babelraid' },
  { name: 'kayjs-playground', repo: 'kaynooo/kayjs-playground' },
  { name: 'assemblee', repo: 'kaynooo/assemblee' },
  { name: 'azael-kaynooo', repo: 'kaynooo/azael-kaynooo', branch: 'kay-port', skip: { test: COMPOSE } },
  { name: 'orbit', repo: 'kaynooo/orbit', dirs: 'workspaces', stubs: ['relay/secrets.env', 'relay/auth/secrets.env'], skip: { test: ORBIT_DATABASE } },
  { name: 'orbit-relay-auth', repo: 'kaynooo/orbit', install: 'relay/auth' },
  { name: 'enshrouded-dashboard', repo: 'kaynooo/enshrouded', install: 'dashboard' },
  { name: 'mc-stats', repo: 'kaynooo/mc-stats' },
]

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
const SCOPE_PREFIX = /^@/
const DOT_SLASH = /^\.\//
const KAY_ALIAS = 'npm:@kaynooo/kayjs@'

export interface Manifest {
  name?: string
  version?: string
  scripts?: Record<string, string>
  [field: string]: unknown
}

// The tarball name `bun pm pack` gives a package.
export const tarballName = (name: string, version: string) => `${name.replace(SCOPE_PREFIX, '').replace('/', '-')}-${version}.tgz`

// A manifest with kay and every kayjs-* library it depends on pointing at the packed tarballs, as an app installing a release has them; undefined when it names none.
export function pointAtKay(manifest: Manifest, tarballs: Record<string, string>): Manifest | undefined {
  let changed = false
  const next: Manifest = { ...manifest }

  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field] as Record<string, string> | undefined

    if (dependencies === undefined)
      continue

    const rewritten: Record<string, string> = {}

    for (const [name, range] of Object.entries(dependencies)) {
      const target = range.startsWith(KAY_ALIAS) ? '@kaynooo/kayjs' : name
      const tarball = tarballs[target]

      if (tarball === undefined) {
        rewritten[name] = range

        continue
      }

      rewritten[name] = `file:${tarball}`
      changed = true
    }

    next[field] = rewritten
  }

  return changed ? next : undefined
}

// Overrides in the root manifest, so the kay and kayjs-* a packed library depends on or peers on come from the tarballs too, not the registry.
export function overrideKay(manifest: Manifest, tarballs: Record<string, string>): Manifest {
  const overrides = Object.fromEntries([...Object.entries(tarballs).map(([name, tarball]) => [name, `file:${tarball}`]), ['kay', `file:${tarballs['@kaynooo/kayjs']}`]])

  // Sorted, as the apps' own lint asks of a manifest.
  const merged: Record<string, string> = { ...(manifest.overrides as Record<string, string> | undefined), ...overrides }

  return { ...manifest, overrides: Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1))) }
}

// The type check and the a11y checks load typescript7 and axe-core from the app, which an app written before kay 1.97 does not list.
export function withPeers(manifest: Manifest): Manifest {
  const devDependencies = { ...manifest.devDependencies as Record<string, string> | undefined }

  for (const name of PEERS)
    devDependencies[name] ??= peerSpec(name).slice(name.length + 1)

  return { ...manifest, devDependencies: Object.fromEntries(Object.entries(devDependencies).sort(([a], [b]) => (a < b ? -1 : 1))) }
}

// The manifests of an app (by path from its repository root) that change to run on the tarballs: those naming kay or a library, and `installPath`, the install root's, with the overrides as soon as any of them changes, so a workspace root that only lists its children pins what their dependencies pull in too.
export function pointApp(manifests: Record<string, Manifest>, installPath: string, tarballs: Record<string, string>): Record<string, Manifest> {
  const pointed: Record<string, Manifest> = {}

  for (const [path, manifest] of Object.entries(manifests)) {
    const next = pointAtKay(manifest, tarballs)

    if (next !== undefined)
      pointed[path] = next
  }

  const rootManifest = pointed[installPath] ?? manifests[installPath]

  if (Object.keys(pointed).length > 0 && rootManifest !== undefined)
    pointed[installPath] = overrideKay(withPeers(rootManifest), tarballs)

  return pointed
}

const root = resolve(import.meta.dir, '..')
const workDir = resolve(process.env.KAY_APPS_DIR ?? join(root, '.kay/apps-ci'))
const tarballDir = join(workDir, 'tarballs')
// The clones live outside the kay checkout, as an app's resolution climbs into kay's own node_modules from inside it and finds a second copy of every package kay has, and in a directory of this run alone, so two runs on one runner never meet; KAY_APPS_CLONES names one instead, which is kept.
let clonesDir: string | undefined

async function clones() {
  clonesDir ??= process.env.KAY_APPS_CLONES === undefined ? await mkdtemp(join(tmpdir(), 'kay-apps-ci-')) : resolve(process.env.KAY_APPS_CLONES)

  return clonesDir
}

async function packageDirs() {
  return ['.', ...(await Array.fromAsync(new Glob('packages/*').scan({ cwd: root, onlyFiles: false })))]
}

async function pack() {
  await rm(tarballDir, { recursive: true, force: true })
  await mkdir(tarballDir, { recursive: true })

  const tarballs: Record<string, string> = {}

  for (const dir of await packageDirs()) {
    const manifest = await Bun.file(join(root, dir, 'package.json')).json() as Manifest

    if (manifest.name === undefined || manifest.version === undefined || manifest.private === true)
      continue

    await $`bun pm pack --destination ${tarballDir} --quiet`.cwd(join(root, dir)).quiet()

    const file = join(tarballDir, tarballName(manifest.name, manifest.version))

    if (!(await Bun.file(file).exists()))
      throw new Error(`${manifest.name}: bun pm pack left no ${file}`)

    tarballs[manifest.name] = file
  }

  await Bun.write(join(tarballDir, 'tarballs.json'), `${JSON.stringify(tarballs, null, 2)}\n`)
  console.log(`packed ${Object.keys(tarballs).join(', ')}`)
}

// The token goes to git through its environment, so it is on no command line and in no .git/config.
async function clone(app: App, directory: string) {
  // A directory holding a checkout per app, cloned from instead of Forgejo, to try this script without the network.
  const local = process.env.KAY_APPS_LOCAL

  if (local !== undefined) {
    const branch = app.branch === undefined ? [] : ['--branch', app.branch]

    await $`git clone --quiet --depth 1 ${branch} ${`file://${resolve(local, existsSync(resolve(local, app.name)) ? app.name : app.repo.slice(app.repo.indexOf('/') + 1))}`} ${directory}`.quiet()

    return
  }

  const token = process.env.KAY_APPS_TOKEN

  if (token === undefined || token === '')
    throw new Error('KAY_APPS_TOKEN is not set: store a read-only Forgejo token with the read:repository scope as the Actions secret KAY_APPS_TOKEN of the kayjs repository')

  const server = process.env.GITHUB_SERVER_URL ?? 'https://git.kaynooo.fr'
  const branch = app.branch === undefined ? [] : ['--branch', app.branch]
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${server}/.extraheader`, GIT_CONFIG_VALUE_0: `Authorization: token ${token}`, GIT_TERMINAL_PROMPT: '0' }
  const result = await $`git clone --quiet --depth 1 ${branch} ${`${server}/${app.repo}.git`} ${directory}`.env(env).quiet().nothrow()

  if (result.exitCode !== 0)
    throw new Error(`${app.name}: cloning ${app.repo} failed (is the token allowed to read it?)\n${result.stderr.toString().trim()}`)
}

async function manifestPaths(directory: string) {
  const files = (await $`git ls-files -- package.json '*/package.json'`.cwd(directory).text()).split('\n')

  return files.filter(file => file !== '' && !file.includes('node_modules'))
}

// Empty files at `stubs`, from `directory`, for those the clone does not hold: a tracked file is left as it is.
export async function writeStubs(directory: string, stubs: string[]) {
  for (const stub of stubs) {
    const path = join(directory, stub)

    if (!existsSync(path))
      await Bun.write(path, '')
  }
}

// The folders of a package.json's `workspaces` (a `dir/*` pattern expanded, a `./` prefix dropped, a `!pattern` excluding what it matches, as Bun reads them) that have a check, lint or test script, relative to `installDir`.
export async function workspaceDirs(installDir: string): Promise<string[]> {
  const manifest = await Bun.file(join(installDir, 'package.json')).json() as { workspaces?: string[] | { packages?: string[] } }
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : manifest.workspaces?.packages ?? []
  const dirs: string[] = []
  const excluded = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => new Glob(pattern.slice(1).replace(DOT_SLASH, '')))

  for (const pattern of patterns.filter(pattern => !pattern.startsWith('!')).map(pattern => pattern.replace(DOT_SLASH, ''))) {
    const matches = pattern.includes('*') ? await Array.fromAsync(new Glob(pattern).scan({ cwd: installDir, onlyFiles: false })) : [pattern]

    for (const dir of matches.sort()) {
      if (dirs.includes(dir) || excluded.some(glob => glob.match(dir)))
        continue

      const file = Bun.file(join(installDir, dir, 'package.json'))

      if (!(await file.exists()))
        continue

      const scripts = ((await file.json()) as Manifest).scripts ?? {}

      if (SCRIPTS.some(script => scripts[script] !== undefined))
        dirs.push(dir)
    }
  }

  return dirs
}

async function run(app: App) {
  const clonesDir = await clones()
  const directory = join(clonesDir, app.name)
  const tarballs = await Bun.file(join(tarballDir, 'tarballs.json')).json() as Record<string, string>
  const installDir = join(directory, app.install ?? '.')

  await rm(directory, { recursive: true, force: true })
  await mkdir(clonesDir, { recursive: true })
  await clone(app, directory)

  await writeStubs(directory, app.stubs ?? [])

  const dirs = app.dirs === 'workspaces' ? await workspaceDirs(installDir) : app.dirs ?? ['.']

  const prefix = app.install === undefined ? '' : `${app.install}/`
  const manifests: Record<string, Manifest> = {}

  for (const path of (await manifestPaths(directory)).filter(file => file.startsWith(prefix)))
    manifests[path] = await Bun.file(join(directory, path)).json() as Manifest

  const pointedManifests = Object.entries(pointApp(manifests, join(app.install ?? '.', 'package.json'), tarballs))

  for (const [path, next] of pointedManifests)
    await Bun.write(join(directory, path), `${JSON.stringify(next, null, 2)}\n`)

  if (pointedManifests.length === 0)
    throw new Error(`${app.name}: no package.json depends on kay, nothing to test`)

  const env: Record<string, string | undefined> = { ...process.env, CI: 'true', HUSKY: '0' }

  // The apps' scripts and their dependencies' install scripts have no use for the token.
  delete env.KAY_APPS_TOKEN
  // Every workspace installs whole; a listed few install through `--filter ./dir`, which names the folder (a bare `dir` names a package, and matched nothing).
  const filters = Array.isArray(app.dirs) && (dirs.length > 1 || dirs[0] !== '.') ? dirs.flatMap(dir => ['--filter', `./${dir}`]) : []

  console.log(`== ${app.name}: install`)
  await $`bun install ${filters}`.cwd(installDir).env(env)

  const failures: string[] = []
  const skipped: string[] = []

  for (const dir of dirs) {
    const label = dir === '.' ? app.name : `${app.name}/${dir}`
    const manifest = await Bun.file(join(installDir, dir, 'package.json')).json() as Manifest

    for (const script of SCRIPTS) {
      const reason = app.skip?.[script] ?? (manifest.scripts?.[script] === undefined ? 'the app has no such script' : undefined)

      if (reason !== undefined) {
        skipped.push(`${label} ${script}: ${reason}`)

        continue
      }

      console.log(`== ${label}: ${script}`)

      const result = await $`bun run ${script}`.cwd(join(installDir, dir)).env(env).nothrow()

      if (result.exitCode !== 0)
        failures.push(`${label} ${script}`)
    }
  }

  for (const line of skipped)
    console.log(`skipped ${line}`)

  if (failures.length > 0)
    throw new Error(`${app.name} fails against this kay: ${failures.join(', ')}`)

  console.log(`${app.name} passes`)
}

if (import.meta.main) {
  const names = process.argv.slice(2)

  if (names[0] === 'pack') {
    await pack()
    process.exit(0)
  }

  if (names.length === 0)
    throw new Error(`usage: bun scripts/apps-ci.ts pack | <app>...\napps: ${APPS.map(app => app.name).join(', ')}`)

  const unknown = names.filter(name => !APPS.some(app => app.name === name))

  if (unknown.length > 0)
    throw new Error(`unknown app ${unknown.join(', ')}`)

  let failed = false

  for (const name of names) {
    try {
      await run(APPS.find(app => app.name === name)!)
    }
    catch (error) {
      failed = true
      console.error((error as Error).message)
    }
  }

  if (process.env.KAY_APPS_CLONES === undefined && clonesDir !== undefined)
    await rm(clonesDir, { recursive: true, force: true })

  process.exit(failed ? 1 : 0)
}
