import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { $, Glob } from 'bun'

// `bun scripts/apps-ci.ts pack` packs kay and each library into KAY_APPS_DIR, `bun scripts/apps-ci.ts <app>...` clones each app, installs it against those tarballs and runs its own check, lint and test scripts: what the Apps workflow runs before a release.
export interface App {
  name: string
  // The Forgejo repository, owner/name.
  repo: string
  // A branch that is not the repository's default.
  branch?: string
  // The packages whose scripts run, relative to the repository root; the root alone by default.
  dirs?: string[]
  // A script that cannot run in CI, with the reason it prints instead.
  skip?: Partial<Record<Script, string>>
}

export type Script = typeof SCRIPTS[number]

export const SCRIPTS = ['check', 'lint', 'test'] as const

const COMPOSE = 'needs the compose stack of its own test database'
const ORBIT_DIRS = ['atlas', 'aurora', 'hubble', 'relay', 'selene']
const ORBIT_DATABASE = 'needs a database and services only its compose files start'

// The apps of the `kay-sites` memory that have a remote; kay-mail-test has none, and relay/auth is not one of orbit's workspaces.
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
  { name: 'orbit', repo: 'kaynooo/orbit', dirs: ORBIT_DIRS, skip: { test: ORBIT_DATABASE } },
]

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
const SCOPE_PREFIX = /^@/
const KAY_ALIAS = 'npm:@kaynooo/kayjs@'

interface Manifest {
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

const root = resolve(import.meta.dir, '..')
const workDir = resolve(process.env.KAY_APPS_DIR ?? join(root, '.kay/apps-ci'))
const tarballDir = join(workDir, 'tarballs')

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

    await $`git clone --quiet --depth 1 ${branch} ${`file://${resolve(local, app.name)}`} ${directory}`.quiet()

    return
  }

  const token = process.env.KAY_APPS_TOKEN

  if (token === undefined || token === '')
    throw new Error('KAY_APPS_TOKEN is not set: store a read-only Forgejo token with the read:repository scope as the Actions secret KAY_APPS_TOKEN of the kayjs repository')

  const server = process.env.GITHUB_SERVER_URL ?? 'https://git.kevyn.fr'
  const branch = app.branch === undefined ? [] : ['--branch', app.branch]
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: `Authorization: token ${token}`, GIT_TERMINAL_PROMPT: '0' }
  const result = await $`git clone --quiet --depth 1 ${branch} ${`${server}/${app.repo}.git`} ${directory}`.env(env).quiet().nothrow()

  if (result.exitCode !== 0)
    throw new Error(`${app.name}: cloning ${app.repo} failed (is the token allowed to read it?)\n${result.stderr.toString().trim()}`)
}

async function manifestPaths(directory: string) {
  const files = (await $`git ls-files -- package.json '*/package.json'`.cwd(directory).text()).split('\n')

  return files.filter(file => file !== '' && !file.includes('node_modules'))
}

async function run(app: App) {
  const directory = join(workDir, 'apps', app.name)
  const tarballs = await Bun.file(join(tarballDir, 'tarballs.json')).json() as Record<string, string>
  const dirs = app.dirs ?? ['.']

  await rm(directory, { recursive: true, force: true })
  await mkdir(join(workDir, 'apps'), { recursive: true })
  await clone(app, directory)

  let pointed = 0

  for (const path of await manifestPaths(directory)) {
    const file = join(directory, path)
    const next = pointAtKay(await Bun.file(file).json() as Manifest, tarballs)

    if (next !== undefined) {
      await Bun.write(file, `${JSON.stringify(next, null, 2)}\n`)
      pointed++
    }
  }

  if (pointed === 0)
    throw new Error(`${app.name}: no package.json depends on kay, nothing to test`)

  const env = { ...process.env, CI: 'true', HUSKY: '0' }
  const filters = dirs.length > 1 || dirs[0] !== '.' ? dirs.flatMap(dir => ['--filter', dir]) : []

  console.log(`== ${app.name}: install`)
  await $`bun install ${filters}`.cwd(directory).env(env)

  const failures: string[] = []
  const skipped: string[] = []

  for (const dir of dirs) {
    const label = dir === '.' ? app.name : `${app.name}/${dir}`
    const manifest = await Bun.file(join(directory, dir, 'package.json')).json() as Manifest

    for (const script of SCRIPTS) {
      const reason = app.skip?.[script] ?? (manifest.scripts?.[script] === undefined ? 'the app has no such script' : undefined)

      if (reason !== undefined) {
        skipped.push(`${label} ${script}: ${reason}`)

        continue
      }

      console.log(`== ${label}: ${script}`)

      const result = await $`bun run ${script}`.cwd(join(directory, dir)).env(env).nothrow()

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

  process.exit(failed ? 1 : 0)
}
