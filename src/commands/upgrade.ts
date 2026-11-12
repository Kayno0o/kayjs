import type { Command, ProblemFormat } from './command'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { engines } from '../../package.json'
import { DEPRECATION_MINORS, minorAfter, minorOf, UPGRADE_FROM } from '../compiler/lints'
import { done, formatOption, printDocument, printFailure, projectRoot } from './command'

// What an upgrade asks of the outside: the registry, the package manager and the project's own kay, which a test replaces so none of them is reached.
export interface UpgradeDeps {
  // The newest version of a package, from the registry the project installs it from.
  latest: (name: string, root: string) => Promise<string | undefined>
  // Installs what `package.json` now asks for, `changes` being the packages that moved.
  install: (root: string, changes: DependencyChange[]) => Promise<boolean>
  // Runs the project's own kay, the one just installed, so the fixes of the minor moved to are the ones applied; answers its exit code and, when `capture`, its stdout.
  kay: (root: string, args: string[], capture: boolean, env?: Record<string, string>) => Promise<{ code: number, stdout: string }>
  // Whether a git working tree holds uncommitted changes to files it tracks, which the rewrite would mix with its own; false outside a repository.
  uncommitted?: (root: string) => Promise<boolean>
}

export interface DependencyChange {
  name: string
  spec: string
  section: string
}

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
// A range that is a version, as `~1.45.0` or `npm:@kaynooo/kayjs@~1.45.0`: what comes before the range, and the version.
const RANGE = /^((?:npm:@?[^@]+@)?)[~^]?(\d+\.\d+\.\d+)$/
// What `bun add` is told to keep a package in the section it was in.
const SECTION_FLAGS: Record<string, string[]> = { devDependencies: ['--dev'], optionalDependencies: ['--optional'] }
const KAY_PACKAGE = '@kaynooo/kayjs'
const SECTION_OPEN = /\s*:\s*\{/y
const LOCKFILES = ['bun.lock', 'bun.lockb']
const PRERELEASE = /[-+].*$/
// The version a range of kay's own dependencies starts at.
const FLOOR = /(\d+\.\d+\.\d+)/
const SEMVER = /^\d+\.\d+\.\d+$/
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

// `bun install` alone can read a hand-edited range as no change and keep the old package in node_modules, so a package still at another version is added again, in the section it was in.
// `logTo` is where the output of the commands it runs goes: this process's stdout, or a file descriptor such as 2 when stdout holds a document.
export function registryDepsFor(bun: string, logTo: 'inherit' | number = 'inherit'): UpgradeDeps {
  return {
    latest: async (name, root) => {
      const { code, stdout } = await run([bun, 'info', name, 'version'], root, true)

      return code === 0 ? stdout.trim() : undefined
    },
    install: async (root, changes) => {
      if ((await run([bun, 'install'], root, false, {}, logTo)).code !== 0)
        return false

      for (const { name, spec, section } of changes) {
        const installed = join(root, 'node_modules', name, 'package.json')
        // `~1.45.0` or `^1.4.31`, the range the installed copy has to satisfy.
        const wanted = spec.slice(spec.lastIndexOf('@') + 1)

        if (existsSync(installed) && Bun.semver.satisfies(((await Bun.file(installed).json()) as { version: string }).version, wanted))
          continue

        const flag = SECTION_FLAGS[section] ?? []

        if ((await run([bun, 'add', ...flag, '--no-cache', `${name}@${spec}`], root, false, {}, logTo)).code !== 0)
          return false
      }

      // bun-plugin-tailwind's auto-installed `bun` peer stays at its old version in the lockfile and shadows the system Bun, which kay then refuses to run on.
      if (await staleBun(root) && (await run([bun, 'update', 'bun'], root, false, {}, logTo)).code !== 0)
        console.error('kay upgrade: `bun update bun` failed; kay refuses to run on the old npm `bun` until it is updated')

      return true
    },
    kay: async (root, args, capture, env) => run([bun, join(root, 'node_modules/kay/src/cli.ts'), ...args], root, capture, env, logTo),
    uncommitted: async (root) => {
      try {
        const { code, stdout } = await run(['git', 'status', '--porcelain', '--untracked-files=no', '--', '.'], root, true)

        return code === 0 && stdout.trim() !== ''
      }
      catch {
        // No git on the machine.
        return false
      }
    },
  }
}

const registryDeps = registryDepsFor(process.execPath)
// Under `--format json` stdout holds the document alone, so what the project's own kay and the install print goes to stderr; nothing else of the upgrade runs the app's code in this process.
const registryDepsToStderr = registryDepsFor(process.execPath, 2)

// Whether the project holds an npm `bun` older than the Bun the installed kay needs.
async function staleBun(root: string): Promise<boolean> {
  const installed = join(root, 'node_modules/bun/package.json')

  if (!existsSync(installed))
    return false

  let version: string | undefined
  let range = engines.bun

  try {
    version = ((await Bun.file(installed).json()) as { version?: string }).version
    range = ((await Bun.file(join(root, 'node_modules/kay/package.json')).json()) as { engines?: { bun?: string } }).engines?.bun ?? range
  }
  catch {
    // An unreadable manifest: no stale `bun` is claimed, and the range of the kay running the upgrade stands.
  }

  return version !== undefined && !Bun.semver.satisfies(version.replace(PRERELEASE, ''), range)
}

// Moves kay and the kay libraries an app lists to their latest version, installs, then has that kay rewrite the old forms the minors crossed deprecated, one minor at a time, and report what is left to do by hand.
export const upgrade: Command = {
  usage: 'upgrade [dir] [--dry-run] [--quiet] [--format text|json]',
  options: { 'dry-run': { type: 'boolean' }, 'quiet': { type: 'boolean' }, 'format': { type: 'string' } },
  positionals: 1,
  run: async ({ values, positionals: [dir] }, refuse) => {
    const format = formatOption(refuse, values.format)

    if (format === undefined)
      return 2

    const root = projectRoot('upgrade', dir, format)

    if (root === undefined)
      return 1

    const options = { dryRun: values['dry-run'] === true, quiet: values.quiet === true, format }

    return upgradeProject(root, format === 'json' ? registryDepsToStderr : registryDeps, options)
  },
}

// What `--format json` prints: each step the upgrade announced, and the packages it moved, or with `dryRun` would move, to the range they ended on.
export interface UpgradeResult {
  steps: { verb: string, rest: string }[]
  changed: DependencyChange[]
}

// With `dryRun`, lists the packages that would move and touches nothing: no write, no install, no rewrite.
export async function upgradeProject(root: string, deps: UpgradeDeps, { dryRun = false, quiet = false, format = 'text' }: { dryRun?: boolean, quiet?: boolean, format?: ProblemFormat } = {}): Promise<number> {
  const result: UpgradeResult = { steps: [], changed: [] }
  // Said in text, or kept in the document under json; quiet, the steps are not announced: what would move, and how it ended, still are.
  const say = (verb: string, rest: string, always: boolean) => {
    result.steps.push({ verb, rest })

    if (format === 'json')
      return

    if (always || !quiet)
      done(verb, rest)
  }
  const step = (verb: string, rest: string) => say(verb, rest, false)
  const finish = (code: number) => {
    if (format === 'json')
      printDocument(result)

    return code
  }
  const moved = (changes: DependencyChange[]) => {
    for (const change of changes)
      result.changed = [...result.changed.filter(({ name }) => name !== change.name), change]
  }
  const manifest = join(root, 'package.json')

  if (!existsSync(manifest)) {
    printFailure('upgrade', `${root} has no package.json`, format)

    return 1
  }

  const original = await Bun.file(manifest).text()
  let packageJson: Record<string, unknown>

  try {
    packageJson = JSON.parse(original)
  }
  catch (error) {
    printFailure('upgrade', `package.json does not parse: ${error instanceof Error ? error.message : String(error)}`, format)

    return 1
  }

  const found = kayDependencies(packageJson)
  const kay = found.find(dependency => dependency.registry === KAY_PACKAGE)

  if (kay === undefined) {
    printFailure('upgrade', 'package.json has no `kay` dependency with a full version range to move, as `npm:@kaynooo/kayjs@~1.45.0`; one written another way, a path or a workspace, is moved by hand', format)

    return 1
  }

  const latestKay = await deps.latest(KAY_PACKAGE, root)

  if (latestKay === undefined || !SEMVER.test(latestKay)) {
    printFailure('upgrade', `the registry gave no version of ${KAY_PACKAGE}`, format)

    return 1
  }

  const from = kay.version
  const latest = new Map<KayDependency, string>()

  for (const dependency of found) {
    const target = dependency === kay ? latestKay : await deps.latest(dependency.registry, root)

    if (target === undefined || !SEMVER.test(target)) {
      printFailure('upgrade', `the registry gave no version of ${dependency.registry}`, format)

      return 1
    }

    latest.set(dependency, target)
  }

  const phases = planPhases(original, found, latest, steppingStones(from, latestKay))

  if (typeof phases === 'string') {
    printFailure('upgrade', `package.json lists ${phases}, but kay could not find that entry to move: edit it by hand, then run \`kay upgrade\` again`, format)

    return 1
  }

  if (phases.every(phase => phase.changes.length === 0)) {
    say('upgraded', `nothing: kay ${from} is the latest, run \`kay check --fix\` for the rest`, true)

    return finish(0)
  }

  if (dryRun) {
    for (const { version, changes, stone } of phases) {
      moved(changes)

      for (const { name, spec } of changes)
        say('would move', `${name} to ${spec.slice(spec.lastIndexOf('~'))}${stone ? ` (kay ${version} still rewrites forms the next minors drop)` : ''}`, true)
    }

    say('dry run', 'nothing written; run `kay upgrade` to install them and rewrite the old forms', true)

    return finish(0)
  }

  if (await deps.uncommitted?.(root) === true)
    console.error('kay upgrade: the working tree has uncommitted changes, which the rewrite of old forms will mix with its own: commit or stash them first to review the upgrade alone')

  // What the project holds after the last phase that landed, so a failing one puts back that state and not an older one.
  let settled = { source: original, locks: await readLocks(root) }
  let behind = from
  // A stone's rewrite that leaves a form behind: the latest kay no longer knows its lint, so only this run can still report it.
  let leftOnTheWay = false

  for (const phase of phases) {
    if (phase.changes.length === 0)
      continue

    await Bun.write(manifest, phase.source)
    moved(phase.changes)
    step('moved', phase.changes.map(({ name, spec }) => `${name} to ${spec.slice(spec.lastIndexOf('~'))}`).join(', '))

    if (!await deps.install(root, phase.changes) || !existsSync(join(root, 'node_modules/kay/src/cli.ts'))) {
      await restore(manifest, settled)

      printFailure('upgrade', behind === from
        ? `the install of kay ${phase.version} failed or left no kay in node_modules, so package.json and the lockfile are back as they were and nothing was rewritten; node_modules may still hold what the install did, so run \`bun install\` once the install is fixed, then \`kay upgrade\` again`
        : `the install of kay ${phase.version} failed or left no kay in node_modules, after the forms of the minors up to ${behind} were rewritten on the way; package.json and the lockfile are back at kay ${behind}, so run \`bun install\` once the install is fixed, then \`kay upgrade\` again`, format)

      return 1
    }

    for (const since of await crossed(root, behind, phase.version, deps)) {
      step('rewriting', `what ${since} deprecated`)
      const rewritten = await deps.kay(root, ['check', '--fix', '--since', since, ...quiet ? ['--quiet'] : []], false, { [UPGRADE_FROM]: from })

      if (phase.stone && rewritten.code !== 0)
        leftOnTheWay = true
    }

    behind = phase.version
    settled = { source: phase.source, locks: await readLocks(root) }
  }

  const raised = await raiseShared(root, manifest, settled.source)

  if (raised.length > 0) {
    moved(raised.map(({ change }) => change))
    step('raised', raised.map(({ change, held }) => `${change.name} to ${change.spec}, which kay ${latestKay} depends on (the app held ${held})`).join(', '))

    if (!await deps.install(root, raised.map(({ change }) => change))) {
      await restore(manifest, settled)
      printFailure('upgrade', `the install of ${raised.map(({ change }) => change.name).join(', ')} failed, so package.json and the lockfile are back at kay ${latestKay}; raise them by hand to what kay asks for, then run \`bun install\``, format)

      return 1
    }
  }

  step('checking', 'what is left')

  const left = await deps.kay(root, ['check', '--fix', '--deny-warnings', ...quiet ? ['--quiet'] : []], false, { [UPGRADE_FROM]: from })

  const clean = left.code === 0 && !leftOnTheWay

  if (clean)
    say('upgraded', `to kay ${latestKay}, nothing left to do by hand`, true)
  else if (format === 'text')
    console.log(`upgraded to kay ${latestKay}, the problems above are left for you`)

  return finish(clean ? 0 : 1)
}

async function restore(manifest: string, settled: { source: string, locks: { path: string, content: Uint8Array | undefined }[] }): Promise<void> {
  await Bun.write(manifest, settled.source)

  for (const { path, content } of settled.locks) {
    if (content !== undefined)
      await Bun.write(path, content)
    else
      await rm(path, { force: true })
  }
}

// A package the app and the installed kay both depend on is installed once only when the app's range and its locked version reach kay's: below it the app keeps its copy and kay gets a second one, whose types do not match the app's (Elysia's `~cookieConfig` is missing).
// Every package of kay's `dependencies` that the app lists with a plain range is raised to the version kay's range starts at, keeping the app's `~` or `^`, and written in place; `source` is the manifest as the phases left it.
async function raiseShared(root: string, manifest: string, source: string): Promise<{ change: DependencyChange, held: string }[]> {
  let kayRanges: Record<string, string>

  try {
    kayRanges = ((await Bun.file(join(root, 'node_modules/kay/package.json')).json()) as { dependencies?: Record<string, string> }).dependencies ?? {}
  }
  catch {
    // No installed kay to read: what it asks is not known.
    return []
  }

  const raised: { change: DependencyChange, held: string }[] = []
  let written = source

  for (const dependency of sharedDependencies(JSON.parse(source) as Record<string, unknown>, kayRanges)) {
    const wanted = FLOOR.exec(kayRanges[dependency.name]!)?.[1]
    const installed = await installedVersion(root, dependency.name)
    const held = installed !== undefined && Bun.semver.order(installed, dependency.version) === -1 ? installed : dependency.version

    if (wanted === undefined || Bun.semver.order(wanted, held) !== 1)
      continue

    const spec = `${dependency.spec.startsWith('~') ? '~' : '^'}${wanted}`
    const replaced = replaceSpec(written, dependency, spec)

    if (replaced !== undefined) {
      written = replaced
      raised.push({ change: { name: dependency.name, spec, section: dependency.section }, held })
    }
  }

  if (raised.length > 0)
    await Bun.write(manifest, written)

  return raised
}

async function installedVersion(root: string, name: string): Promise<string | undefined> {
  try {
    return ((await Bun.file(join(root, 'node_modules', name, 'package.json')).json()) as { version?: string }).version
  }
  catch {
    return undefined
  }
}

// The app's dependencies that kay's own `dependencies` list too, as a plain range of the registry.
function sharedDependencies(packageJson: Record<string, unknown>, kayRanges: Record<string, string>): KayDependency[] {
  const found: KayDependency[] = []

  for (const section of SECTIONS) {
    const listed = packageJson[section]

    if (typeof listed !== 'object' || listed === null)
      continue

    for (const [name, spec] of Object.entries(listed)) {
      const range = typeof spec === 'string' && name in kayRanges ? RANGE.exec(spec) : null

      if (range !== null && range[1] === '')
        found.push({ name, spec: spec as string, section, registry: name, prefix: '', version: range[2]! })
    }
  }

  return found
}

async function readLocks(root: string): Promise<{ path: string, content: Uint8Array | undefined }[]> {
  return Promise.all(LOCKFILES.map(async name => ({ path: join(root, name), content: existsSync(join(root, name)) ? await Bun.file(join(root, name)).bytes() : undefined })))
}

// One install of the upgrade: the ranges `source` holds once its `changes` are written, and the version of kay then installed.
interface Phase {
  version: string
  source: string
  changes: DependencyChange[]
  // A minor passed through on the way, not the one the upgrade ends on.
  stone: boolean
}

// The versions an upgrade installs before the latest, oldest first: each is the minor before a release that dropped the lints rewriting forms the app may still hold, so that minor's kay rewrites them. A form is the app's to keep when its minor is not after the one the app is on, as in `crossed`.
export function steppingStones(from: string, to: string, table: typeof DEPRECATION_MINORS = DEPRECATION_MINORS): string[] {
  const toMinor = minorOf(to)!
  const stones: string[] = []
  let behind = minorOf(from)!

  const dropped = table.flatMap(({ since, removedIn }) => (removedIn === undefined ? [] : [{ since, removedIn }]))

  for (const { removedIn, since } of dropped.toSorted((a, b) => minorOf(a.removedIn)![1] - minorOf(b.removedIn)![1])) {
    const removed = minorOf(removedIn)!

    if (minorAfter(removed, toMinor) || !minorAfter(minorOf(since)!, behind))
      continue

    behind = [removed[0], removed[1] - 1]
    stones.push(`${behind[0]}.${behind[1]}.0`)
  }

  return stones
}

// The phases from the app's ranges to the latest ones, the ranges of each written over the text of the one before; the name of a dependency whose entry cannot be found in the text when one cannot.
function planPhases(original: string, found: KayDependency[], latest: Map<KayDependency, string>, stones: string[]): Phase[] | string {
  const state = found.map(dependency => ({ ...dependency }))
  const phases: Phase[] = []
  let source = original

  for (const stone of [...stones, undefined]) {
    const changes: DependencyChange[] = []

    for (const [index, dependency] of state.entries()) {
      const target = stone ?? latest.get(found[index]!)!

      if (Bun.semver.order(target, dependency.version) !== 1)
        continue

      const spec = `${dependency.prefix}~${target}`
      const replaced = replaceSpec(source, dependency, spec)

      if (replaced === undefined)
        return `${dependency.name} as ${JSON.stringify(dependency.spec)} in "${dependency.section}"`

      source = replaced
      dependency.spec = spec
      dependency.version = target
      changes.push({ name: dependency.name, spec, section: dependency.section })
    }

    phases.push({ version: stone ?? latest.get(found.find(dependency => dependency.registry === KAY_PACKAGE)!)!, source, changes, stone: stone !== undefined })
  }

  return phases
}

interface KayDependency extends DependencyChange {
  // What `bun info` is asked: the package behind an alias.
  registry: string
  prefix: string
  version: string
}

// The dependencies that are kay or one of its libraries, as a version range of the registry; a path, a workspace or a git source is left as it is.
function kayDependencies(packageJson: Record<string, unknown>): KayDependency[] {
  const found: KayDependency[] = []

  for (const section of SECTIONS) {
    const listed = packageJson[section]

    if (typeof listed !== 'object' || listed === null)
      continue

    for (const [name, spec] of Object.entries(listed)) {
      const range = typeof spec === 'string' ? RANGE.exec(spec) : null

      if (range === null)
        continue

      const [, prefix = '', version = ''] = range
      const registry = prefix === '' ? name : prefix.slice('npm:'.length, -1)

      if (registry === KAY_PACKAGE || registry.startsWith(`${KAY_PACKAGE}-`))
        found.push({ name, spec: spec as string, section, registry, prefix, version })
    }
  }

  return found
}

// The minors, oldest first, that deprecated a form between the version the app was on and the one it moves to, as the installed kay lists them: an older kay lists none.
async function crossed(root: string, from: string, to: string, deps: UpgradeDeps): Promise<string[]> {
  const { code, stdout } = await deps.kay(root, ['explain', 'deprecated', '--format', 'json'], true)
  const fromMinor = minorOf(from)!
  const toMinor = minorOf(to)!
  let lints: { since?: string }[] = []

  try {
    lints = code === 0 ? (JSON.parse(stdout) as { lints?: { since?: string }[] }).lints ?? [] : []
  }
  catch {
    // An older kay prints no such document: it lists no deprecation.
  }

  const sinces = new Set(lints.flatMap(lint => lint.since === undefined ? [] : [lint.since]))

  return [...sinces]
    .filter((since) => {
      const minor = minorOf(since)

      return minor !== undefined && minorAfter(minor, fromMinor) && !minorAfter(minor, toMinor)
    })
    .sort((a, b) => minorAfter(minorOf(a)!, minorOf(b)!) ? 1 : -1)
}

// The span inside the braces of a top-level section of package.json, read as JSON text: a string holding a brace, or a same-named key nested deeper, is not mistaken for it.
function sectionSpan(source: string, section: string): { start: number, end: number } | undefined {
  let depth = 0
  let start: number | undefined
  let index = 0

  while (index < source.length) {
    const char = source[index]!

    if (char === '"') {
      let close = index + 1

      while (close < source.length && source[close] !== '"')
        close += source[close] === '\\' ? 2 : 1

      if (start === undefined && depth === 1 && source.slice(index + 1, close) === section) {
        SECTION_OPEN.lastIndex = close + 1

        const after = SECTION_OPEN.exec(source)

        if (after) {
          start = close + 1 + after[0].length
          depth = 2
          index = start

          continue
        }
      }

      index = close + 1

      continue
    }

    if (char === '{' || char === '[')
      depth++
    else if (char === '}' || char === ']')
      depth--

    if (start !== undefined && depth === 1)
      return { start, end: index }

    index++
  }

  return undefined
}

// Rewrites the range inside the section listing the dependency, so a same-looking range in `overrides` or `peerDependencies` is left alone; undefined when no such entry was found.
function replaceSpec(source: string, dependency: KayDependency, spec: string): string | undefined {
  const span = sectionSpan(source, dependency.section)

  if (span === undefined)
    return undefined

  const entry = new RegExp(`("${dependency.name.replace(REGEX_SPECIALS, '\\$&')}"\\s*:\\s*)${JSON.stringify(dependency.spec).replace(REGEX_SPECIALS, '\\$&')}`)
  const inside = source.slice(span.start, span.end)

  return entry.test(inside) ? source.slice(0, span.start) + inside.replace(entry, (_whole, key: string) => `${key}${JSON.stringify(spec)}`) + source.slice(span.end) : undefined
}

async function run(args: string[], root: string, capture: boolean, env: Record<string, string> = {}, logTo: 'inherit' | number = 'inherit'): Promise<{ code: number, stdout: string }> {
  const child = Bun.spawn(args, { cwd: root, env: { ...process.env, ...env }, stdin: 'ignore', stdout: capture ? 'pipe' : logTo, stderr: 'inherit' })
  const [stdout, code] = await Promise.all([capture ? new Response(child.stdout as ReadableStream).text() : '', child.exited])

  return { code, stdout }
}
