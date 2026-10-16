import type { Command } from './command'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
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
const SECTION_OPEN = /\s*:\s*\{/y
const LOCKFILES = ['bun.lock', 'bun.lockb']
const SEMVER = /^\d+\.\d+\.\d+$/
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

// `bun install` alone can read a hand-edited range as no change and keep the old package in node_modules, so a package still at another version is added again, in the section it was in.
export function registryDepsFor(bun: string): UpgradeDeps {
  return {
    latest: async (name, root) => {
      const { code, stdout } = await run([bun, 'info', name, 'version'], root, true)

      return code === 0 ? stdout.trim() : undefined
    },
    install: async (root, changes) => {
      if ((await run([bun, 'install'], root, false)).code !== 0)
        return false

      for (const { name, spec, section } of changes) {
        const installed = join(root, 'node_modules', name, 'package.json')
        const wanted = spec.slice(spec.lastIndexOf('~') + 1)

        if (existsSync(installed) && ((await Bun.file(installed).json()) as { version?: string }).version === wanted)
          continue

        const flag = SECTION_FLAGS[section] ?? []

        if ((await run([bun, 'add', ...flag, '--no-cache', `${name}@${spec}`], root, false)).code !== 0)
          return false
      }

      return true
    },
    kay: async (root, args, capture) => run([bun, join(root, 'node_modules/kay/src/cli.ts'), ...args], root, capture),
  }
}

const registryDeps = registryDepsFor(process.execPath)

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

  const original = await Bun.file(manifest).text()
  const locks = await Promise.all(LOCKFILES.map(async name => ({ path: join(root, name), content: existsSync(join(root, name)) ? await Bun.file(join(root, name)).bytes() : undefined })))
  let source = original
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
    printFailure('upgrade', 'package.json has no `kay` dependency with a full version range to move, as `npm:@kaynooo/kayjs@~1.45.0`; one written another way, a path or a workspace, is moved by hand', 'text')

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

    if (Bun.semver.order(target, dependency.version) !== 1)
      continue

    const spec = `${dependency.prefix}~${target}`

    const replaced = replaceSpec(source, dependency, spec)

    if (replaced === undefined) {
      printFailure('upgrade', `package.json lists ${dependency.name} as ${JSON.stringify(dependency.spec)} in "${dependency.section}", but kay could not find that entry to move: edit it by hand, then run \`kay upgrade\` again`, 'text')

      return 1
    }

    source = replaced
    changes.push({ name: dependency.name, spec, section: dependency.section })
  }

  if (changes.length === 0) {
    done('upgraded', `nothing: kay ${from} is the latest, run \`kay check --fix\` for the rest`)

    return 0
  }

  await Bun.write(manifest, source)
  done('moved', changes.map(({ name, spec }) => `${name} to ${spec.slice(spec.lastIndexOf('~'))}`).join(', '))

  if (!await deps.install(root, changes) || !existsSync(join(root, 'node_modules/kay/src/cli.ts'))) {
    await Bun.write(manifest, original)

    for (const { path, content } of locks) {
      if (content !== undefined)
        await Bun.write(path, content)
      else
        await rm(path, { force: true })
    }

    printFailure('upgrade', 'the install failed or left no kay in node_modules, so package.json and the lockfile are back as they were and nothing was rewritten; node_modules may still hold what the install did, so run `bun install` once the install is fixed, then `kay upgrade` again', 'text')

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

async function run(args: string[], root: string, capture: boolean): Promise<{ code: number, stdout: string }> {
  const child = Bun.spawn(args, { cwd: root, stdin: 'ignore', stdout: capture ? 'pipe' : 'inherit', stderr: 'inherit' })
  const [stdout, code] = await Promise.all([capture ? new Response(child.stdout).text() : '', child.exited])

  return { code, stdout }
}
