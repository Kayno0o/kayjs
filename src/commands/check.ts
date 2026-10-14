import type { Subprocess } from 'bun'
import type { CheckDiagnostic } from '../check'
import type { LintGroup } from '../compiler/lints'
import type { KayConfig } from '../config'
import type { Command, ProblemFormat } from './command'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { realPath } from '../build/files'
import { applySafeFixes, check as checkTypes, configCheckOptions } from '../check'
import { isLint, isLintGroup, LINT_GROUPS, LINTS } from '../compiler/lints'
import { CONFIG_FILE, loadConfig } from '../config'
import { watchProject } from '../dev'
import { buildingWithoutEnv } from '../server/env'
import { count, done, formatOption, printFailure, printProblems, PROBLEM_FORMATS, projectRoot } from './command'

const CLI = join(import.meta.dir, '../cli.ts')
// What makes a directory given first the project rather than a path to report on.
const PROJECT_FILES = [CONFIG_FILE, 'package.json', 'tsconfig.json']
// Erases the screen and its scrollback, then moves to the top.
const CLEAR_SCREEN = '\x1B[2J\x1B[3J\x1B[H'
// An editor's save comes as several changes.
const WATCH_DEBOUNCE_MS = 50

// `--format github` annotates a CI diff and `--format json` gives tools one document; the exit code is the same in every format.
export const check: Command = {
  usage: 'check [dir] [paths...] [-p tsconfig.json] [--entry <file>] [--deny-warnings] [--fix] [--only <group>] [--format text|github|json] [--watch]',
  options: { 'project': { type: 'string', short: 'p' }, 'entry': { type: 'string' }, 'deny-warnings': { type: 'boolean' }, 'fix': { type: 'boolean' }, 'only': { type: 'string' }, 'format': { type: 'string' }, 'watch': { type: 'boolean' } },
  positionals: Infinity,
  run: async ({ values, positionals }) => {
    const { project, entry } = values
    const only = typeof values.only === 'string' ? values.only : undefined
    const format = formatOption('check', values.format, PROBLEM_FORMATS)

    if (format === undefined)
      return 1

    if (only !== undefined && !isLintGroup(only)) {
      console.error(`kay check: --only takes a group of lints, ${Object.keys(LINT_GROUPS).map(group => `\`${group}\``).join(', ')}, not \`${only}\``)

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
        ...only === undefined ? [] : ['--only', only],
      ]

      // The text report goes to stderr; the other formats are left whole for what reads them.
      await watchChecks(root, [CLI, 'check', ...positionals, ...flags, '--format', format], format)

      return 0
    }

    // The checking machine lacks the server's environment, as `kay build` does, which kay.config.ts may import.
    buildingWithoutEnv()

    const started = performance.now()

    try {
      const { failing, found } = await checkProject(root, await loadConfig(root), typeof project === 'string' ? project : 'tsconfig.json', typeof entry === 'string' ? relative(root, resolve(entry)) : undefined, { denyWarnings: values['deny-warnings'] === true, fix: values.fix === true, only, launch: only === 'seo', format, scope })

      if (found === 0 && format !== 'json')
        done('checked', 'with no problems', performance.now() - started)

      return failing > 0 ? 1 : 0
    }
    catch (error) {
      printFailure('check', error, format)

      return 1
    }
  },
}

// Checks now and again on every change to the project, its tests included, a change during a check bringing one more; until interrupted.
// Each check is a `kay check` of its own, so an edit to kay.config.ts or a module it imports is read again, which a process's import cache would not, and a check that throws or exits leaves the watch going.
async function watchChecks(root: string, args: string[], format: ProblemFormat): Promise<never> {
  const clear = format === 'text' && process.stderr.isTTY
  let changed = false
  let running: Promise<void> | undefined
  let timer: Timer | undefined
  let child: Subprocess | undefined
  let stopping = false
  const checks = async () => {
    do {
      changed = false

      if (clear)
        process.stderr.write(CLEAR_SCREEN)

      // A process group of its own, so an interrupt stops what it runs too, such as the type checker.
      child = Bun.spawn([process.execPath, ...args], { stdio: ['ignore', 'inherit', 'inherit'], detached: true })

      const code = await child.exited

      // Stopped by the watch, which exits starting no other.
      if (stopping)
        break

      // A config or a module it imports calling `process.exit()`, or a crash, leaves no report of its own.
      if (code > 1)
        printFailure('check', child.signalCode ? `the check died of ${child.signalCode} before reporting` : `the check stopped with exit code ${code} before reporting`, format)
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

      return
    }

    stopping = true

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
  watchProject(root, () => {
    changed = true
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
async function checkProject(root: string, config: KayConfig, tsconfig: string, entry: string | undefined, { denyWarnings, fix, only, launch, format, scope }: { denyWarnings: boolean, fix: boolean, only: LintGroup | undefined, launch: boolean, format: ProblemFormat, scope: string[] }): Promise<{ failing: number, found: number }> {
  const options = { ...configCheckOptions(config), tsconfig, entry, launch }
  const checkScope = async () => (await checkTypes(root, options)).filter(diagnostic => inScope(diagnostic, scope))
  let diagnostics = await checkScope()
  const fixed = fix ? await applySafeFixes(root, diagnostics) : 0

  if (fixed > 0) {
    // JSON is the whole of stdout.
    if (format === 'json')
      console.error(`kay check: fixed ${count(fixed, 'problem')}`)
    else
      done('fixed', count(fixed, 'problem'))

    diagnostics = await checkScope()
  }

  if (only !== undefined)
    diagnostics = diagnostics.filter(diagnostic => isLint(diagnostic.code) && LINTS[diagnostic.code].group === only)

  return printProblems(diagnostics, denyWarnings, format)
}
