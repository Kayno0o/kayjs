import type { CheckDiagnostic } from '../check'
import type { LintGroup } from '../compiler/lints'
import type { KayConfig } from '../config'
import type { Command, ProblemFormat } from './command'
import { existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { applySafeFixes, check as checkTypes, configCheckOptions } from '../check'
import { isLint, isLintGroup, LINT_GROUPS, LINTS } from '../compiler/lints'
import { CONFIG_FILE, loadConfig } from '../config'
import { watchProject } from '../dev'
import { buildingWithoutEnv } from '../server/env'
import { count, done, isProblemFormat, printProblems, PROBLEM_FORMATS, projectRoot } from './command'

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
    const format = typeof values.format === 'string' ? values.format : 'text'

    if (!isProblemFormat(format)) {
      console.error(`kay check: --format takes ${PROBLEM_FORMATS.map(name => `\`${name}\``).join(', ')}, not \`${format}\``)

      return 1
    }

    if (only !== undefined && !isLintGroup(only)) {
      console.error(`kay check: --only takes a group of lints, ${Object.keys(LINT_GROUPS).map(group => `\`${group}\``).join(', ')}, not \`${only}\``)

      return 1
    }

    // The first path is the project when it is one; the others, or all of them otherwise, are what to report on, relative to the current directory.
    const [first, ...rest] = positionals
    const dir = first !== undefined && PROJECT_FILES.some(file => existsSync(join(first, file))) ? first : undefined
    const paths = dir === undefined ? positionals : rest
    const missing = paths.find(path => !existsSync(path))

    if (missing !== undefined) {
      console.error(`kay check: ${missing} does not exist`)

      return 1
    }

    const root = projectRoot('check', dir)

    if (root === undefined)
      return 1

    // The checking machine lacks the server's environment, as `kay build` does, which kay.config.ts may import.
    buildingWithoutEnv()

    const scope = paths.map(path => resolve(path))
    const run = async () => {
      const started = performance.now()
      const { failing, found } = await checkProject(root, await loadConfig(root), typeof project === 'string' ? project : 'tsconfig.json', typeof entry === 'string' ? relative(root, resolve(entry)) : undefined, { denyWarnings: values['deny-warnings'] === true, fix: values.fix === true, only, launch: only === 'seo', format, scope })

      if (found === 0 && format !== 'json')
        done('checked', 'with no problems', performance.now() - started)

      return failing > 0 ? 1 : 0
    }

    if (values.watch !== true)
      return run()

    // The text report goes to stderr; the other formats are left whole for what reads them.
    await watchChecks(root, run, format === 'text' && process.stderr.isTTY)

    return 0
  },
}

// Checks now and again on every change to the project, its tests included, a change during a check bringing one more; until interrupted.
async function watchChecks(root: string, run: () => Promise<unknown>, clear: boolean): Promise<never> {
  let changed = false
  let running: Promise<void> | undefined
  let timer: Timer | undefined
  const checks = async () => {
    do {
      changed = false

      if (clear)
        process.stderr.write(CLEAR_SCREEN)

      await run()
    } while (changed)

    running = undefined
  }

  running = checks()
  watchProject(root, () => {
    changed = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      running ??= checks()
    }, WATCH_DEBOUNCE_MS)
  }, { tests: true })

  return new Promise<never>(() => undefined)
}

function inScope(diagnostic: CheckDiagnostic, scope: string[]): boolean {
  return scope.length === 0 || scope.some(path => diagnostic.file === path || diagnostic.file.startsWith(path + sep))
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
