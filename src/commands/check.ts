import type { Subprocess } from 'bun'
import type { CheckDiagnostic } from '../check'
import type { Lint, LintGroup } from '../compiler/lints'
import type { KayConfig } from '../config'
import type { Command, ProblemFormat } from './command'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { realPath } from '../build/files'
import { pruneCheckCache } from '../build/transform'
import { applySafeFixes, check as checkTypes, configCheckOptions } from '../check'
import { isLint, isLintGroup, LINT_GROUPS, LINTS, UPGRADE_FROM } from '../compiler/lints'
import { CONFIG_FILE, loadConfig } from '../config'
import { watchProject } from '../dev/sources'
import { cacheDir } from '../project'
import { buildingWithoutEnv } from '../server/env-state'
import { count, done, formatOption, printFailure, printProblems, PROBLEM_FORMATS, projectRoot, takesControlCodes } from './command'
import { runProjectChecks } from './project-checks'
import { USAGES } from './usages'

const CLI = join(import.meta.dir, '../cli.ts')
// What makes a directory given first the project rather than a path to report on.
const PROJECT_FILES = [CONFIG_FILE, 'package.json', 'tsconfig.json']
// A minor as `1.46`, which a version with a patch is not.
const SINCE = /^\d+\.\d+$/
// Erases the screen and its scrollback, then moves to the top.
const CLEAR_SCREEN = '\x1B[2J\x1B[3J\x1B[H'
// An editor's save comes as several changes.
const WATCH_DEBOUNCE_MS = 50

// `--format github` annotates a CI diff and `--format json` gives tools one document; the exit code is the same in every format.
export const check: Command = {
  usage: USAGES.check,
  options: { 'project': { type: 'string', short: 'p' }, 'entry': { type: 'string' }, 'deny-warnings': { type: 'boolean' }, 'fix': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'only': { type: 'string' }, 'since': { type: 'string' }, 'format': { type: 'string' }, 'watch': { type: 'boolean' }, 'quiet': { type: 'boolean' } },
  positionals: Infinity,
  run: async ({ values, positionals }) => {
    const { project, entry } = values
    const only = typeof values.only === 'string' ? values.only : undefined
    const since = typeof values.since === 'string' ? values.since : undefined
    const format = formatOption('check', values.format, PROBLEM_FORMATS)

    if (format === undefined)
      return 1

    if (only !== undefined && !isLintGroup(only)) {
      console.error(`kay check: --only takes a group of lints, ${Object.keys(LINT_GROUPS).map(group => `\`${group}\``).join(', ')}, not \`${only}\``)

      return 1
    }

    if (since !== undefined && (only !== undefined || !SINCE.test(since))) {
      console.error(only === undefined ? `kay check: --since takes a minor, as \`1.46\`, not \`${since}\`` : 'kay check: --since reports the deprecations of one minor, so it does not go with --only')

      return 1
    }

    // The first path is the project when it is one; the others, or all of them otherwise, are what to report on, relative to the current directory.
    const [first, ...rest] = positionals
    const dir = first !== undefined && isProjectDir(first) ? first : undefined
    const paths = dir === undefined ? positionals : rest
    const missing = paths.find(path => !existsSync(path))

    if (missing !== undefined) {
      printFailure('check', `${missing} does not exist`, format)

      return 1
    }

    const root = projectRoot('check', dir, format)

    if (root === undefined)
      return 1

    const scope = realScope(root, paths, format)

    if (scope === undefined)
      return 1

    if (values.watch === true) {
      const flags = [
        ...typeof project === 'string' ? ['-p', project] : [],
        ...typeof entry === 'string' ? ['--entry', entry] : [],
        ...values['deny-warnings'] === true ? ['--deny-warnings'] : [],
        ...values.fix === true ? ['--fix'] : [],
        ...values['dry-run'] === true ? ['--dry-run'] : [],
        ...values.quiet === true ? ['--quiet'] : [],
        ...only === undefined ? [] : ['--only', only],
        ...since === undefined ? [] : ['--since', since],
      ]

      // The text report goes to stderr; the other formats are left whole for what reads them.
      let config: KayConfig | undefined
      let failed = false
      const inProcess = async () => {
        const code = await checkOnce(root, async () => {
          try {
            return config ??= await loadConfig(root)
          }
          catch (error) {
            failed = true

            throw error
          }
        }, { project, entry, values, only, since, format, scope })

        // A config that does not load is read again by the next check, a process of its own.
        return failed ? 2 : code
      }

      await watchChecks(root, [CLI, 'check', ...positionals, ...flags, '--format', format], format, inProcess)

      return 0
    }

    return checkOnce(root, async () => loadConfig(root), { project, entry, values, only, since, format, scope })
  },
}

interface CheckRun {
  project: unknown
  entry: unknown
  values: { 'deny-warnings'?: boolean, 'fix'?: boolean, 'quiet'?: boolean }
  only: LintGroup | undefined
  since: string | undefined
  format: ProblemFormat
  scope: string[]
}

// One check of the project, printed, answering the exit code: 1 for a problem that fails it or an error thrown.
async function checkOnce(root: string, config: () => Promise<KayConfig>, { project, entry, values, only, since, format, scope }: CheckRun): Promise<number> {
  // The checking machine lacks the server's environment, as `kay build` does, which kay.config.ts may import.
  buildingWithoutEnv()

  const started = performance.now()

  try {
    const { failing, found } = await checkProject(root, await config(), typeof project === 'string' ? project : 'tsconfig.json', typeof entry === 'string' ? relative(root, resolve(entry)) : undefined, { denyWarnings: values['deny-warnings'] === true, fix: values.fix === true || values['dry-run'] === true, dryRun: values['dry-run'] === true, only, since, launch: only === 'seo', format, scope, quiet: values.quiet === true })

    if (found === 0 && format !== 'json')
      done('checked', 'with no problems', performance.now() - started)

    return failing > 0 ? 1 : 0
  }
  catch (error) {
    printFailure('check', error, format)

    return 1
  }
}

// Checks now and again on every change to the project, its tests included, a change during a check bringing one more; until interrupted.
// Each check is a `kay check` of its own, so an edit to kay.config.ts or a module it imports is read again, which a process's import cache would not, and a check that throws or exits leaves the watch going.
// Once one of them has reported, a change to `.kay` files alone is checked in the watch's own process with the config it first read, which spares the spawn and the config's load.
// A change to anything else after that read ends it: the process's caches would serve the config, the modules it imports and the installed libraries as they were, so every later check is a process of its own.
async function watchChecks(root: string, args: string[], format: ProblemFormat, inProcess: () => Promise<number>): Promise<never> {
  const clear = format === 'text' && takesControlCodes(process.stderr)
  let changed = false
  let running: Promise<void> | undefined
  let timer: Timer | undefined
  let child: Subprocess | undefined
  let stopping = false
  // Whether a change reached anything but a `.kay` file, and whether the last check ended in a report, which a check run in this process relies on the config of.
  let beyondKay = true
  let reported = false
  let inside = false
  let retired = false
  let read = false
  const checks = async () => {
    do {
      changed = false

      const here = reported && !beyondKay && !retired

      beyondKay = false

      if (clear)
        process.stderr.write(CLEAR_SCREEN)

      if (here) {
        inside = true
        read = true
        reported = await inProcess() <= 1
        inside = false

        if (stopping)
          break

        continue
      }

      // A process group of its own, so an interrupt stops what it runs too, such as the type checker.
      const spawned = Bun.spawn([process.execPath, ...args], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })

      child = spawned

      const code = await spawned.exited

      // The child is gone, which a second interrupt during a check in this process must not signal.
      child = undefined

      // Stopped by the watch, which exits starting no other.
      if (stopping)
        break

      reported = code <= 1

      // A config or a module it imports calling `process.exit()`, or a crash, leaves no report of its own.
      if (code > 1)
        printFailure('check', spawned.signalCode !== null ? `the check died of ${spawned.signalCode} before reporting` : `the check stopped with exit code ${code} before reporting`, format, null)
    } while (changed)

    child = undefined
    running = undefined
  }

  const signalGroup = (check: Subprocess, signal: NodeJS.Signals) => {
    try {
      process.kill(-check.pid, signal)
    }
    catch {
      // The check ended meanwhile, its group with it.
    }
  }
  // A second interrupt kills a check that has not stopped at the first.
  const stop = async (signal: NodeJS.Signals, code: number) => {
    if (stopping) {
      if (child)
        signalGroup(child, 'SIGKILL')
      else if (inside)
        process.exit(code)

      return
    }

    stopping = true

    // A check in this process ends on its own, the type checker it started with it.
    if (inside)
      await running

    const check = child

    if (check) {
      signalGroup(check, signal)
      await check.exited
      // What it started and left ignoring the signal goes with it.
      signalGroup(check, 'SIGKILL')
    }

    process.exit(code)
  }

  // A closed terminal hangs up on the watch alone, the check running in a session of its own.
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const)
    process.on(signal, () => void stop(signal, code))

  running = checks()
  watchProject(root, (file) => {
    changed = true

    if (!file.endsWith('.kay')) {
      beyondKay = true
      retired ||= read
    }

    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!stopping)
        running ??= checks()
    }, WATCH_DEBOUNCE_MS)
  }, { tests: true })

  return new Promise<never>(() => undefined)
}

// A directory holding a project's files, or outside the current directory, where no path to report on lies.
function isProjectDir(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true && (PROJECT_FILES.some(file => existsSync(join(path, file))) || !within(process.cwd(), resolve(path)))
}

// The paths to report on as their real paths, a symlink to the project's files read as those files; undefined, once said why, for one outside the project, which no problem the check finds could be in.
function realScope(root: string, paths: string[], format: ProblemFormat): string[] | undefined {
  const realRoot = realpathSync(root)
  const scope = paths.map(path => realpathSync(resolve(path)))
  const outside = paths.find((_path, index) => !within(realRoot, scope[index]!))

  if (outside === undefined)
    return scope

  printFailure('check', `${outside} is outside the project at ${relative(process.cwd(), root) || '.'}, so kay check finds nothing in it`, format)

  return undefined
}

function within(dir: string, path: string): boolean {
  const outside = relative(dir, path)

  return outside !== '..' && !outside.startsWith(`..${sep}`) && !isAbsolute(outside)
}

function inScope(diagnostic: CheckDiagnostic, scope: string[]): boolean {
  if (scope.length === 0)
    return true

  const file = realPath(diagnostic.file)

  return scope.some(path => file === path || file.startsWith(path + sep))
}

// Prints what `kay check` finds in the project and answers how many it found and how many of those fail it: the errors, and the warnings too with `denyWarnings`.
// With `fix`, applies the safe fixes first, then checks again and prints what is left; with `only`, prints that group's lints alone; with a `scope`, the problems in those files and directories alone, the project still checked as a whole.
async function checkProject(root: string, config: KayConfig, tsconfig: string, entry: string | undefined, { denyWarnings, fix, dryRun, only, since, launch, format, scope, quiet }: { denyWarnings: boolean, fix: boolean, dryRun: boolean, only: LintGroup | undefined, since: string | undefined, launch: boolean, format: ProblemFormat, scope: string[], quiet: boolean }): Promise<{ failing: number, found: number }> {
  const options = { ...configCheckOptions(config), tsconfig, entry: entry ?? config.entry, launch }
  let everything = await checkTypes(root, options)
  const checkScope = async () => {
    everything = await checkTypes(root, options)

    return everything.filter(diagnostic => inScope(diagnostic, scope))
  }
  let diagnostics = everything.filter(diagnostic => inScope(diagnostic, scope))

  // A path filter only narrows what is reported, but a run asked for one is not the whole check the entries of deleted components can be judged against.
  if (scope.length === 0)
    await pruneCheckCache(cacheDir(root))

  // `since` narrows what is fixed and reported to the deprecations of one minor, which `kay upgrade` applies in order.
  const inMinor = (diagnostic: CheckDiagnostic) => isLint(diagnostic.code) && (LINTS[diagnostic.code] as Lint).since === since
  // A prop's type, its reads and the tags passing it are fixed together, so a run narrowed to one file fixes the others of that migration too.
  const migration = (diagnostic: CheckDiagnostic) => diagnostic.code === 'deprecated-signal-prop'
  const fixable = diagnostics.some(migration) ? [...diagnostics, ...everything.filter(diagnostic => migration(diagnostic) && !diagnostics.includes(diagnostic))] : diagnostics
  const fixed = fix ? await applySafeFixes(root, since === undefined ? fixable : fixable.filter(inMinor), !dryRun) : 0

  if (fixed > 0) {
    // JSON is the whole of stdout; quiet, what is left is all that is said.
    if (format === 'json')
      console.error(`kay check: ${dryRun ? 'would fix' : 'fixed'} ${count(fixed, 'problem')}`)
    else if (!quiet)
      done(dryRun ? 'would fix' : 'fixed', count(fixed, 'problem'))

    if (!dryRun)
      diagnostics = await checkScope()
  }

  // The app's own checks run once, after the fixes.
  // They have no lint, so a run narrowed to a group or a minor leaves them out.
  if (only === undefined && since === undefined) {
    const env = await envProblems(root, config, scope)

    diagnostics.push(...fix && !dryRun && process.env[UPGRADE_FROM] === undefined ? await declareRawReads(root, env, format, quiet) : env, ...(await runProjectChecks(root, config)).filter(diagnostic => inScope(diagnostic, scope)))
  }

  if (since !== undefined)
    diagnostics = diagnostics.filter(inMinor)

  if (only !== undefined)
    diagnostics = diagnostics.filter(diagnostic => isLint(diagnostic.code) && LINTS[diagnostic.code].group === only)

  return printProblems(diagnostics, denyWarnings, format)
}

const UNDECLARED_READ = /^process\.env\.(\w+) is read with no schema/

// With `--fix`, and outside `kay upgrade`, which rewrites no source but what a deprecation names, declares the raw reads the env comparison warns of in the project's `defineEnv` schema and answers the problems left.
async function declareRawReads(root: string, problems: CheckDiagnostic[], format: ProblemFormat, quiet: boolean): Promise<CheckDiagnostic[]> {
  const names = new Set(problems.flatMap(problem => UNDECLARED_READ.exec(problem.message)?.[1] ?? []))

  if (names.size === 0)
    return problems

  const { declareRawEnv } = await import('./env-declare')
  const declared = await declareRawEnv(root, names, new Set(problems.map(problem => problem.file)))

  if (declared.names.size === 0)
    return problems

  if (format === 'json')
    console.error(`kay check: fixed ${count(declared.reads, 'problem')}`)
  else if (!quiet)
    done('fixed', count(declared.reads, 'problem'))

  return problems.filter(problem => !declared.names.has(UNDECLARED_READ.exec(problem.message)?.[1] ?? ''))
}

// What `env` in kay.config.ts has compared: the declared variables against the compose and example files it names, else against the project's production compose files and `.env.example`; `env: false` compares nothing.
async function envProblems(root: string, config: KayConfig, scope: string[]): Promise<CheckDiagnostic[]> {
  const { compareEnv, defaultEnvFiles } = await import('./env-compare')
  const files = config.env === false ? undefined : config.env ?? await defaultEnvFiles(root)

  if (files === undefined)
    return []

  const { listEnv } = await import('./env')
  const { variables, unread } = await listEnv(root)

  return (await compareEnv(root, variables, files, unread)).filter(diagnostic => inScope(diagnostic, scope))
}
