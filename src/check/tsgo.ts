// The `bun check` run `kay check` makes, skipped where its last run was clean and nothing it read has changed since, and what it prints read back as diagnostics, with the helpers on tsgo that read a config and map its codes.
import type { CheckDiagnostic } from '.'
import type { TsgoDiagnostic } from './diagnose'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { readCacheEntry, writeCacheEntry } from '../build/cache'
import { treeEntries } from '../build/files'
import { offsetAt } from '../compiler/mapping'
import { nativeExe, nativeManifest } from '../compiler/native-typescript'
import { projectPaths } from '../project'

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (?:error|warning) (TS\d+): (.*)$/
// An error about the whole run, such as a tsconfig that does not exist.
const TSC_GLOBAL_LINE = /^error (TS\d+): (.*)$/

// The options that name a place, which do not change what a file's types are.
const PLACED_OPTIONS = new Set(['rootDirs', 'rootDir', 'paths', 'baseUrl', 'typeRoots', 'outDir', 'declarationDir', 'tsBuildInfoFile', 'configFilePath', 'pathsBasePath'])
// The longest one `bun check` run may take, which a hung one would otherwise hold `kay check` for good.
const CHECK_TIMEOUT = 5 * 60_000
// A filesystem stamps writes off a coarse clock, milliseconds behind on Linux and up to a second on some, so a file written that close before a run counts as written after it.
const CLOCK_SLACK = 1000
// What `bun check` prints on stderr that is not a failure: the count of errors or the all-clear, the errors per file and line below it, and the notes explaining a stop the errors already show.
const SUMMARY_LINE = /^(?:Found \d+ errors?\b|✓ No type errors |note: | +\d+ +\S.*:\d+$|$)/
const LISTED_FILE = /^(?:bundled:|\/|[A-Za-z]:[\\/])/
const LINE_BREAK = /\r?\n/
const LOCK_FILES = ['bun.lock', 'bun.lockb']

// What tsgo or `bun check` printed, one diagnostic a line, the lines after one that start no other added to its message.
export function parseTscOutput(output: string, config: string, root: string): CheckDiagnostic[] {
  const diagnostics: CheckDiagnostic[] = []

  for (const line of output.split('\n')) {
    const match = TSC_LINE.exec(line)

    if (match) {
      diagnostics.push({ file: resolve(root, match[1]!), line: Number(match[2]), column: Number(match[3]), code: match[4], message: match[5]! })

      continue
    }

    const global = TSC_GLOBAL_LINE.exec(line)

    if (global) {
      diagnostics.push({ file: config, line: 1, column: 1, code: global[1], message: global[2]! })

      continue
    }

    const last = diagnostics.at(-1)

    if (last && line.trim() !== '')
      last.message += `\n${line}`
  }

  return diagnostics
}

// The project's tsconfig as tsgo resolves it, its extends, options and root files, or undefined when tsgo cannot read it.
export async function resolvedConfig(root: string, tsconfig: string): Promise<string | undefined> {
  const child = Bun.spawn([nativeExe(), '--showConfig', '-p', tsconfig], { cwd: root, stdout: 'pipe', stderr: 'ignore' })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  return code === 0 ? output : undefined
}

// What a tsconfig's own options say apart from the places they name, which differ by where the config sits: two configs with the same text here type a file the same way.
// Kept while the config and each config it extends keep their size and time, as tsgo would print the same: a run on a project whose configs did not change spawns nothing.
export async function typingOptions(root: string, tsconfig: string): Promise<string | undefined> {
  const config = resolve(root, tsconfig)
  const stamps = configStamps(config)
  const slot = stamps === undefined ? undefined : { file: join(projectPaths(root).cache, 'config', `${Bun.hash(config).toString(36)}.json`), key: JSON.stringify([(await Bun.file(nativeManifest()).json() as { version: string }).version, stamps]) }
  const kept = slot && await readCacheEntry<string>(slot)

  if (kept !== undefined)
    return kept

  const shown = await resolvedConfig(root, tsconfig)

  if (shown === undefined)
    return undefined

  const { compilerOptions = {} } = JSON.parse(shown) as { compilerOptions?: Record<string, unknown> }
  const options = JSON.stringify(Object.entries(compilerOptions).filter(([name]) => !PLACED_OPTIONS.has(name)).toSorted(([a], [b]) => a < b ? -1 : 1))

  if (slot)
    await writeCacheEntry(slot, options)

  return options
}

// The size and time of a config and of every config it extends, or undefined when one cannot be found or read, which leaves the answer to tsgo.
function configStamps(config: string, seen = new Set<string>()): string[] | undefined {
  if (seen.has(config))
    return []

  seen.add(config)

  try {
    const stat = statSync(config, { throwIfNoEntry: false })

    if (stat === undefined)
      return undefined

    const { size, mtimeMs } = stat
    const { extends: base } = Bun.JSONC.parse(readFileSync(config, 'utf8')) as { extends?: string | string[] }
    const stamps = [`${config}:${size}:${mtimeMs}`]

    for (const name of typeof base === 'string' ? [base] : base ?? []) {
      const found = extendedConfig(dirname(config), name)

      if (found === undefined)
        return undefined

      const inner = configStamps(found, seen)

      if (inner === undefined)
        return undefined

      stamps.push(...inner)
    }

    return stamps
  }
  catch {
    return undefined
  }
}

// The config an `extends` names, a file beside the one extending or one a package ships.
function extendedConfig(dir: string, name: string): string | undefined {
  const candidates = name.startsWith('.') || isAbsolute(name) ? [resolve(dir, name), resolve(dir, `${name}.json`)] : [name, `${name}.json`, `${name}/tsconfig.json`]

  for (const candidate of candidates) {
    try {
      const found = name.startsWith('.') || isAbsolute(name) ? candidate : Bun.resolveSync(candidate, dir)

      if (statSync(found, { throwIfNoEntry: false })?.isFile())
        return found
    }
    catch {}
  }

  return undefined
}

// Runs `bun check`, or not at all when its last run was clean and nothing it read has changed since: a warm run is then a handful of `stat` calls.
// `program` names the run among the several of one project, each keeping its own state.
export async function typecheck(root: string, tsconfig: string, shown: string | undefined, program = '', timeout = CHECK_TIMEOUT): Promise<{ output: string, errors: string, code: number }> {
  const { cache, types: shadowDir } = projectPaths(root)
  const state = join(cache, 'check', program)
  const args = ['check', '--no-pretty', '--all', '--noUnusedLocals', '--listFiles', '-p', tsconfig]
  // The resolved config lists the root files, so one added or removed changes it as an edited option does.
  const slot = shown === undefined ? undefined : { file: join(state, 'clean.json'), key: JSON.stringify([Bun.revision, args, shown]) }
  const last = slot && await readCacheEntry<CleanRun>(slot)

  const checked = last && await stillClean(last, shadowDir)

  if (checked?.clean)
    return { output: '', errors: '', code: 0 }

  const obsolete = dropObsoleteState(state)
  const generated = checked?.hashes ?? await contentHashes(shadowDir)
  const started = Date.now()
  // A project's own `check` script would run in the place of the type checker, which Bun skips for a process started as that script is, unless `npm_package_json` names another project's package.json, as it does under a script of the project that runs kay.
  const child = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, npm_lifecycle_event: 'check', npm_package_json: undefined } })
  let stopped = false
  // A timer of kay's own rather than the spawn's `timeout`, which a loaded parallel test run was seen to let pass.
  const timer = setTimeout(() => {
    stopped = true
    child.kill()
  }, timeout)
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited, obsolete])

  clearTimeout(timer)

  const { output, listed } = splitListing(stdout)
  const errors = withoutSummary(stderr)

  if (stopped)
    return { output, errors: `kay: bun check did not finish within ${timeout / 1000} s and was stopped`, code: 1 }

  if (slot && code === 0 && output === '' && errors === '')
    await writeCacheEntry(slot, { started, ...filesRead(root, listed.filter(file => !Object.hasOwn(generated, file))), generated } satisfies CleanRun)

  return { output, errors, code }
}

// Where kay kept tsgo's build info before it ran `bun check`, which has none.
async function dropObsoleteState(state: string): Promise<void> {
  await Promise.all(['tsbuildinfo', 'declarations'].map(async name => rm(join(state, name), { force: true })))
}

// `--listFiles` prints the files after the diagnostics, one absolute path to a line, so any other line belongs to a diagnostic.
export function splitListing(stdout: string): { output: string, listed: string[] } {
  const output: string[] = []
  const listed: string[] = []

  for (const line of stdout.split(LINE_BREAK)) {
    if (TSC_LINE.test(line) || !LISTED_FILE.test(line))
      output.push(line)
    else if (!line.startsWith('bundled:'))
      listed.push(line)
  }

  return { output: output.join('\n'), listed }
}

// What `bun check` says on stderr besides a failure to run, so a line Bun adds to its summary shows as a problem rather than going unseen: the count of errors or the all-clear, and the notes that explain a stop already visible in the errors.
export function withoutSummary(stderr: string): string {
  return stderr.split(LINE_BREAK).filter(line => !SUMMARY_LINE.test(line)).join('\n').trim()
}

interface CleanRun {
  started: number
  // Every file the run read, packages' own included, by its times, and the files that would change what it read were they to appear.
  files: string[]
  missing: string[]
  // What kay wrote to the shadow tree just before the run, by content: it rewrites a file there on every check that changes it, too close to the run for its times to tell.
  generated: Record<string, string>
}

// `bun check` lists the files it read but not the package.json files that decide how each is read, so the ones in the folders above them are added, with the lock files above the project, which an install changes.
function filesRead(root: string, listed: string[]): Pick<CleanRun, 'files' | 'missing'> {
  const files = new Set(listed)
  const missing = new Set<string>()
  const watch = (folders: Set<string>, names: string[]) => {
    for (const folder of folders) {
      for (const name of names)
        (existsSync(join(folder, name)) ? files : missing).add(join(folder, name))
    }
  }
  const above = new Set<string>()
  const project = new Set<string>()

  for (const file of listed)
    foldersAbove(dirname(file), above)

  foldersAbove(resolve(root), project)
  watch(above, ['package.json'])
  watch(project, ['package.json', ...LOCK_FILES])

  return { files: [...files], missing: [...missing] }
}

// The folder and each one above it, stopping at one already in `folders`, whose own parents are then in it too.
function foldersAbove(start: string, folders: Set<string>): void {
  for (let folder = start; !folders.has(folder); folder = dirname(folder)) {
    folders.add(folder)

    if (dirname(folder) === folder)
      break
  }
}

async function contentHashes(dir: string): Promise<Record<string, string>> {
  const files = existsSync(dir) ? (await treeEntries(dir)).files : []

  return Object.fromEntries(await Promise.all(files.map(async file => [file, Bun.hash(await Bun.file(file).bytes()).toString(36)] as const)))
}

// A file's change time moves when it is written, replaced or linked anew, which a package manager hardlinking an older file into node_modules does while keeping its modification time.
// The shadow tree's hashes come back when they were read, for the run that follows a change to use.
async function stillClean(run: CleanRun, shadowDir: string): Promise<{ clean: boolean, hashes?: Record<string, string> }> {
  const unchanged = run.files.every((file) => {
    const stats = statSync(file, { throwIfNoEntry: false })

    return stats !== undefined && Math.max(stats.mtimeMs, stats.ctimeMs) < run.started - CLOCK_SLACK
  })

  if (!unchanged || run.missing.some(file => existsSync(file)))
    return { clean: false }

  const hashes = await contentHashes(shadowDir)
  const entries = Object.entries(hashes)

  return { clean: entries.length === Object.keys(run.generated).length && entries.every(([file, hash]) => run.generated[file] === hash), hashes }
}

// What tsgo printed, at its offset in the file it read.
export function tsgoDiagnostic(diagnostic: CheckDiagnostic, text: string): TsgoDiagnostic {
  const start = offsetAt(text, diagnostic)

  return { code: tsgoCode(diagnostic), message: diagnostic.message, start, end: start }
}

// `TS2322` as tsgo numbers it.
export function tsgoCode(diagnostic: CheckDiagnostic): number | undefined {
  return diagnostic.code === undefined ? undefined : Number(diagnostic.code.slice(2))
}
