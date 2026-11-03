import type { Subprocess } from 'bun'
import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

// Which components are islands on this branch against main, for kay's own apps: `bun scripts/island-roles.ts [--ref <rev>] [--only <target>...] [--format text|json]`.
// Each target is built with `kay build --format json --no-check` on the working tree and on a temporary worktree of main, installed on its own as the `base` CLI links the checkout's node_modules, whose `kay` and libraries would then be this branch's: the docs site, each `packages/*/tests/fixture`, `examples/*`, `bench/apps/kay` and a `kay new` scaffold.
// It diffs `built.sizes.islands` (the role of each file, and its cause) and each `built.routes[].islands`, prints every changed role and cause, and exits 1 when a component is an island here that main had neither as an island nor as `promoted: true`: no component that is static today may become an island.
// A target built on main and not on this branch is left out, one built only on this branch is an error, as main has nothing to compare it with.
// An interrupted run removes its worktree and stops its builds; two runs at once each have their own.
const HERE = resolve(import.meta.dir, '..')
const SCAFFOLD = 'new-scaffold'

export interface Role {
  promoted: boolean
  why?: string | undefined
}

// What one build says: the role of each island file and the files each route loads.
export interface Roles {
  files: Record<string, Role>
  routes: Record<string, string[]>
}

export type Collected = Record<string, Roles | { error: string }>

export interface Change {
  target: string
  file: string
  before: 'island' | 'promoted' | 'none'
  after: 'island' | 'promoted' | 'none'
  why?: string | undefined
  beforeWhy?: string | undefined
}

export interface RouteChange {
  target: string
  route: string
  added: string[]
  removed: string[]
}

export interface Comparison {
  changes: Change[]
  routes: RouteChange[]
  // A component that is an island on the branch and was neither an island nor promoted on main.
  violations: Change[]
  errors: string[]
}

interface BuildDocument {
  built?: { sizes?: { islands?: { file: string, why?: string, promoted?: boolean }[] }, routes?: { route: string, islands?: string[] }[] }
}

// The roles in a `kay build --format json` document.
export function rolesOf(document: BuildDocument): Roles {
  const files: Record<string, Role> = {}
  const routes: Record<string, string[]> = {}

  for (const island of document.built?.sizes?.islands ?? [])
    files[island.file] = { promoted: island.promoted === true, ...island.why !== undefined && { why: island.why } }

  for (const route of document.built?.routes ?? [])
    routes[route.route] = [...route.islands ?? []].sort()

  return { files, routes }
}

function roleOf(roles: Roles | undefined, file: string): Change['before'] {
  const role = roles?.files[file]

  if (role === undefined)
    return 'none'

  return role.promoted ? 'promoted' : 'island'
}

// The changed roles and causes of every target built on both sides; a target that failed to build on either side is an error, not a pass.
export function compare(before: Collected, after: Collected): Comparison {
  const changes: Change[] = []
  const routes: RouteChange[] = []
  const errors: string[] = []

  for (const [target, now] of Object.entries(after)) {
    const was = before[target]

    if ('error' in now) {
      errors.push(`${target}: the build on this branch failed: ${now.error}`)

      continue
    }

    if (was === undefined || 'error' in was) {
      errors.push(`${target}: ${was === undefined ? 'main did not build it' : `the build on main failed: ${was.error}`}, so its roles are not compared`)

      continue
    }

    for (const file of [...new Set([...Object.keys(was.files), ...Object.keys(now.files)])].sort()) {
      const from = roleOf(was, file)
      const to = roleOf(now, file)
      const why = now.files[file]?.why
      const beforeWhy = was.files[file]?.why

      if (from !== to || why !== beforeWhy)
        changes.push({ target, file, before: from, after: to, why, beforeWhy })
    }

    for (const route of [...new Set([...Object.keys(was.routes), ...Object.keys(now.routes)])].sort()) {
      const had = new Set(was.routes[route] ?? [])
      const has = new Set(now.routes[route] ?? [])
      const added = [...has].filter(file => !had.has(file))
      const removed = [...had].filter(file => !has.has(file))

      if (added.length > 0 || removed.length > 0)
        routes.push({ target, route, added, removed })
    }
  }

  const violations = changes.filter(change => change.after === 'island' && change.before === 'none')

  // A route loading a file main's route did not, which main had as no island at all.
  for (const route of routes) {
    for (const file of route.added) {
      const main = before[route.target]

      if (main !== undefined && !('error' in main) && roleOf(main, file) === 'none' && !violations.some(violation => violation.target === route.target && violation.file === file))
        violations.push({ target: route.target, file, before: 'none', after: 'island', why: (after[route.target] as Roles | undefined)?.files[file]?.why })
    }
  }

  return { changes, routes, violations, errors }
}

export function formatComparison({ changes, routes, violations, errors }: Comparison): string {
  const lines: string[] = []
  const show = (change: Change) => `${change.target}: ${change.file}: ${change.before} -> ${change.after}${change.why === undefined ? '' : `, ${change.why}`}${change.beforeWhy !== undefined && change.beforeWhy !== change.why ? ` (was ${change.beforeWhy})` : ''}`

  for (const change of changes)
    lines.push(`changed  ${show(change)}`)

  for (const route of routes)
    lines.push(`route    ${route.target}: ${route.route}: +${route.added.length} -${route.removed.length}${[...route.added.map(file => ` +${file}`), ...route.removed.map(file => ` -${file}`)].join('')}`)

  for (const violation of violations)
    lines.push(`FAIL     ${show(violation)}: static on main, an island here`)

  for (const error of errors)
    lines.push(`ERROR    ${error}`)

  lines.push(changes.length + routes.length === 0 && errors.length === 0 ? 'no role changed' : `${changes.length} role${changes.length === 1 ? '' : 's'} changed, ${violations.length} new island${violations.length === 1 ? '' : 's'}, ${errors.length} error${errors.length === 1 ? '' : 's'}`)

  return lines.join('\n')
}

// The entries of a folder, none when it is not there: a tree without examples or a library without a fixture has nothing to build.
async function listing(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return []

    throw error
  }
}

// The scaffold of this run, so two runs of the script do not scaffold into the same folder.
function scaffoldDir(tree: string): string {
  return join(tree, '.kay/scratch', `${SCAFFOLD}-${process.pid}`)
}

// The apps to build, by the name each is reported under.
async function targets(tree: string): Promise<Record<string, string>> {
  const found: Record<string, string> = { docs: join(tree, 'docs'), bench: join(tree, 'bench/apps/kay') }

  for (const library of await listing(join(tree, 'packages'))) {
    if ((await listing(join(tree, 'packages', library, 'tests/fixture'))).length > 0)
      found[`${library}-fixture`] = join(tree, 'packages', library, 'tests/fixture')
  }

  for (const example of await listing(join(tree, 'examples')))
    found[`example-${example}`] = join(tree, 'examples', example)

  found[SCAFFOLD] = scaffoldDir(tree)

  return found
}

// The builds running, which an interrupted or failed run stops.
const running = new Set<Subprocess>()
let stopped = false

function stopBuilds(): void {
  stopped = true

  for (const child of running)
    child.kill()
}

async function run(argv: string[], cwd = HERE): Promise<{ out: string, err: string, code: number }> {
  const environment = { ...process.env }

  delete environment.BUN_TEST_WORKER_ID

  const child = Bun.spawn(argv, { cwd, env: environment, stdout: 'pipe', stderr: 'pipe' })

  running.add(child)

  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    return { out, err, code }
  }
  finally {
    running.delete(child)
  }
}

// The scaffold sits under the checkout, where the packages it imports resolve from, so it builds the kay of the tree it was made in.
async function scaffold(tree: string): Promise<void> {
  const dir = scaffoldDir(tree)

  await rm(dir, { recursive: true, force: true })

  const made = await run([process.execPath, join(tree, 'src/cli.ts'), 'new', dir, '-y', '--quiet'], tree)

  if (made.code !== 0)
    throw new Error(`kay new exited with ${made.code}: ${made.out}${made.err}`)
}

function firstLine(text: string): string {
  const end = text.indexOf('\n')

  return end === -1 ? text : text.slice(0, end)
}

async function collect(tree: string, only: string[]): Promise<Collected> {
  const all = await targets(tree)
  const collected: Collected = {}

  for (const [name, dir] of Object.entries(all)) {
    if (stopped)
      break

    if (only.length > 0 && !only.includes(name))
      continue

    try {
      if (name === SCAFFOLD)
        await scaffold(tree)

      const built = await run([process.execPath, join(tree, 'src/cli.ts'), 'build', dir, '--no-check', '--quiet', '--format', 'json'], tree)
      const document = JSON.parse(built.out.trim().split('\n').findLast(line => line.startsWith('{')) ?? '') as BuildDocument & { failed?: { stage: string } }

      collected[name] = document.failed === undefined ? rolesOf(document) : { error: `the build failed at ${document.failed.stage}` }
    }
    catch (error) {
      collected[name] = { error: firstLine(error instanceof Error ? error.message : String(error)) }
    }
    finally {
      if (name === SCAFFOLD)
        await rm(dir, { recursive: true, force: true })
    }
  }

  return collected
}

// The targets built in a temporary worktree of `ref`, with its own dependencies.
async function collectAt(ref: string, only: string[]): Promise<Collected> {
  const dir = join(HERE, '.kay/scratch', `island-roles-main-${process.pid}`)
  const git = async (...argv: string[]) => run(['git', ...argv])
  const remove = async () => {
    await git('worktree', 'remove', '--force', dir)
    await rm(dir, { recursive: true, force: true })
  }
  const interrupted = () => {
    stopBuilds()
    void remove().finally(() => process.exit(130))
  }

  await remove()

  const added = await git('worktree', 'add', '--detach', dir, ref)

  if (added.code !== 0)
    throw new Error(`git worktree add ${ref} exited with ${added.code}: ${added.err.trim()}`)

  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)

  try {
    const installed = await run(['bun', 'install', '--frozen-lockfile'], dir)

    if (installed.code !== 0)
      throw new Error(`bun install in the worktree of ${ref} exited with ${installed.code}: ${installed.err.trim().split('\n').slice(-3).join('\n')}`)

    return await collect(dir, only)
  }
  finally {
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
    await remove()
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { ref: { type: 'string' }, only: { type: 'string', multiple: true }, format: { type: 'string' } } })
  const only = values.only ?? []
  const known = Object.keys(await targets(HERE))
  const unknown = only.filter(name => !known.includes(name))

  if (unknown.length > 0) {
    console.error(`island-roles: no target ${unknown.join(', ')}; the targets are ${known.join(', ')}`)
    process.exit(2)
  }

  let sides: [Collected, Collected]

  try {
    sides = await Promise.all([collectAt(values.ref ?? 'main', only), collect(HERE, only)])
  }
  catch (error) {
    stopBuilds()

    throw error
  }

  const comparison = compare(...sides)

  console.log(values.format === 'json' ? JSON.stringify(comparison, null, 2) : formatComparison(comparison))
  process.exitCode = comparison.violations.length > 0 || comparison.errors.length > 0 ? 1 : 0
}
