import type { Command } from './command'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { minorAfter, minorOf } from '../compiler/lints'
import { done, printFailure, projectRoot } from './command'
import { USAGES } from './usages'

// What an upgrade asks of the outside: the registry, the package manager and the project's own kay, which a test replaces so none of them is reached.
export interface UpgradeDeps {
  // The newest version of a package, from the registry the project installs it from.
  latest: (name: string, root: string) => Promise<string | undefined>
  // Installs what `package.json` now asks for, `changes` being the packages that moved.
  install: (root: string, changes: DependencyChange[]) => Promise<boolean>
  // Runs the project's own kay, the one just installed, so the fixes of the minor moved to are the ones applied; answers its exit code and, when `capture`, its stdout.
  kay: (root: string, args: string[], capture: boolean) => Promise<{ code: number, stdout: string }>
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
const SEMVER = /^\d+\.\d+\.\d+$/
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

// `bun install` alone can read a hand-edited range as no change and keep the old package in node_modules, so a package still at another version is added again, in the section it was in.
const registryDeps: UpgradeDeps = {
  latest: async (name, root) => {
    const { code, stdout } = await run([process.execPath, 'info', name, 'version'], root, true)

    return code === 0 ? stdout.trim() : undefined
  },
  install: async (root, changes) => {
    if ((await run([process.execPath, 'install'], root, false)).code !== 0)
      return false

    for (const { name, spec, section } of changes) {
      const installed = join(root, 'node_modules', name, 'package.json')
      const wanted = spec.slice(spec.lastIndexOf('~') + 1)

      if (existsSync(installed) && ((await Bun.file(installed).json()) as { version?: string }).version === wanted)
        continue

      const flag = SECTION_FLAGS[section] ?? []

      if ((await run([process.execPath, 'add', ...flag, '--no-cache', `${name}@${spec}`], root, false)).code !== 0)
        return false
    }

    return true
  },
  kay: async (root, args, capture) => run([process.execPath, join(root, 'node_modules/kay/src/cli.ts'), ...args], root, capture),
}

// Moves kay and the kay libraries an app lists to their latest version, installs, then has that kay rewrite the old forms the minors crossed deprecated, one minor at a time, and report what is left to do by hand.
export const upgrade: Command = {
  usage: USAGES.upgrade,
  options: {},
  positionals: 1,
  run: async ({ positionals: [dir] }) => {
    const root = projectRoot('upgrade', dir)

    return root === undefined ? 1 : upgradeProject(root, registryDeps)
  },
}

export async function upgradeProject(root: string, deps: UpgradeDeps): Promise<number> {
  const manifest = join(root, 'package.json')

  if (!existsSync(manifest)) {
    printFailure('upgrade', `${root} has no package.json`, 'text')

    return 1
  }

  let source = await Bun.file(manifest).text()
  let packageJson: Record<string, unknown>

  try {
    packageJson = JSON.parse(source)
  }
  catch (error) {
    printFailure('upgrade', `package.json does not parse: ${error instanceof Error ? error.message : String(error)}`, 'text')

    return 1
  }

  const found = kayDependencies(packageJson)
  const kay = found.find(dependency => dependency.registry === KAY_PACKAGE)

  if (kay === undefined) {
    printFailure('upgrade', 'package.json has no `kay` dependency to move, a version range of `@kaynooo/kayjs`; one pointing at a path or a workspace is moved by hand', 'text')

    return 1
  }

  const latestKay = await deps.latest(KAY_PACKAGE, root)

  if (latestKay === undefined || !SEMVER.test(latestKay)) {
    printFailure('upgrade', `the registry gave no version of ${KAY_PACKAGE}`, 'text')

    return 1
  }

  const from = kay.version
  const changes: DependencyChange[] = []

  for (const dependency of found) {
    const target = dependency === kay ? latestKay : await deps.latest(dependency.registry, root)

    if (target === undefined || !SEMVER.test(target)) {
      printFailure('upgrade', `the registry gave no version of ${dependency.registry}`, 'text')

      return 1
    }

    if (!newer(target, dependency.version))
      continue

    const spec = `${dependency.prefix}~${target}`

    source = source.replace(new RegExp(`("${dependency.name.replace(REGEX_SPECIALS, '\\$&')}"\\s*:\\s*)${JSON.stringify(dependency.spec).replace(REGEX_SPECIALS, '\\$&')}`), (_whole, key: string) => `${key}${JSON.stringify(spec)}`)
    changes.push({ name: dependency.name, spec, section: dependency.section })
  }

  if (changes.length === 0) {
    done('upgraded', `nothing: kay ${from} is the latest, run \`kay check --fix\` for the rest`)

    return 0
  }

  await Bun.write(manifest, source)
  done('moved', changes.map(({ name, spec }) => `${name} to ${spec.slice(spec.lastIndexOf('~'))}`).join(', '))

  if (!await deps.install(root, changes)) {
    printFailure('upgrade', 'the install failed, so nothing was rewritten; fix it, then run `kay upgrade` again or `kay check --fix`', 'text')

    return 1
  }

  if (!existsSync(join(root, 'node_modules/kay/src/cli.ts'))) {
    printFailure('upgrade', 'kay is not installed in node_modules after the install, so nothing was rewritten; run `kay check --fix` once it is', 'text')

    return 1
  }

  for (const since of await crossed(root, from, latestKay, deps)) {
    done('rewriting', `what ${since} deprecated`)
    await deps.kay(root, ['check', '--fix', '--since', since], false)
  }

  done('checking', 'what is left')

  const left = await deps.kay(root, ['check', '--fix'], false)

  if (left.code === 0)
    done('upgraded', `to kay ${latestKay}, nothing left to do by hand`)
  else
    console.log(`upgraded to kay ${latestKay}, the problems above are left for you`)

  return left.code === 0 ? 0 : 1
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
    lints = []
  }

  const sinces = new Set(lints.flatMap(lint => lint.since === undefined ? [] : [lint.since]))

  return [...sinces]
    .filter((since) => {
      const minor = minorOf(since)

      return minor !== undefined && minorAfter(minor, fromMinor) && !minorAfter(minor, toMinor)
    })
    .sort((a, b) => minorAfter(minorOf(a)!, minorOf(b)!) ? 1 : -1)
}

function newer(a: string, b: string): boolean {
  const [left, right] = [a, b].map(version => version.split('.').map(Number))

  for (const [index, part] of left!.entries()) {
    if (part !== right![index])
      return part > right![index]!
  }

  return false
}

async function run(args: string[], root: string, capture: boolean): Promise<{ code: number, stdout: string }> {
  const child = Bun.spawn(args, { cwd: root, stdin: 'ignore', stdout: capture ? 'pipe' : 'inherit', stderr: 'inherit' })
  const [stdout, code] = await Promise.all([capture ? new Response(child.stdout).text() : '', child.exited])

  return { code, stdout }
}
