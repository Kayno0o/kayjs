import type { LintGroup } from '../compiler/lints'
import type { KayConfig } from '../config'
import type { Command, ProblemFormat } from './command'
import { relative, resolve } from 'node:path'
import { applySafeFixes, check as checkTypes, configCheckOptions } from '../check'
import { isLint, isLintGroup, LINT_GROUPS, LINTS } from '../compiler/lints'
import { loadConfig } from '../config'
import { buildingWithoutEnv } from '../server/env'
import { count, done, isProblemFormat, printProblems, PROBLEM_FORMATS, projectRoot } from './command'

// `--format github` annotates a CI diff and `--format json` gives tools one document; the exit code is the same in every format.
export const check: Command = {
  usage: 'check [dir] [-p tsconfig.json] [--entry <file>] [--deny-warnings] [--fix] [--only <group>] [--format text|github|json]',
  options: { 'project': { type: 'string', short: 'p' }, 'entry': { type: 'string' }, 'deny-warnings': { type: 'boolean' }, 'fix': { type: 'boolean' }, 'only': { type: 'string' }, 'format': { type: 'string' } },
  positionals: 1,
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

    const root = projectRoot('check', positionals[0])

    if (root === undefined)
      return 1

    // The checking machine lacks the server's environment, as `kay build` does, which kay.config.ts may import.
    buildingWithoutEnv()

    const started = performance.now()
    const { failing, found } = await checkProject(root, await loadConfig(root), typeof project === 'string' ? project : 'tsconfig.json', typeof entry === 'string' ? relative(root, resolve(entry)) : undefined, { denyWarnings: values['deny-warnings'] === true, fix: values.fix === true, only, launch: only === 'seo', format })

    if (found === 0 && format !== 'json')
      done('checked', 'with no problems', performance.now() - started)

    return failing > 0 ? 1 : 0
  },
}

// Prints what `kay check` finds in the project and answers how many it found and how many of those fail it: the errors, and the warnings too with `denyWarnings`.
// With `fix`, applies the safe fixes first, then checks again and prints what is left; with `only`, prints that group's lints alone.
async function checkProject(root: string, config: KayConfig, tsconfig: string, entry: string | undefined, { denyWarnings, fix, only, launch, format }: { denyWarnings: boolean, fix: boolean, only: LintGroup | undefined, launch: boolean, format: ProblemFormat }): Promise<{ failing: number, found: number }> {
  const options = { ...configCheckOptions(config), tsconfig, entry, launch }
  let diagnostics = await checkTypes(root, options)
  const fixed = fix ? await applySafeFixes(root, diagnostics) : 0

  if (fixed > 0) {
    // JSON is the whole of stdout.
    if (format === 'json')
      console.error(`kay check: fixed ${count(fixed, 'problem')}`)
    else
      done('fixed', count(fixed, 'problem'))

    diagnostics = await checkTypes(root, options)
  }

  if (only !== undefined)
    diagnostics = diagnostics.filter(diagnostic => isLint(diagnostic.code) && LINTS[diagnostic.code].group === only)

  return printProblems(diagnostics, denyWarnings, format)
}
