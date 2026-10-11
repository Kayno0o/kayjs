import type { LintGroup } from '../compiler/lints'
import type { KayConfig } from '../config'
import type { Command } from './command'
import { relative, resolve } from 'node:path'
import { applySafeFixes, check as checkTypes, configCheckOptions } from '../check'
import { isLint, isLintGroup, LINT_GROUPS, LINTS } from '../compiler/lints'
import { loadConfig } from '../config'
import { buildingWithoutEnv } from '../server/env'
import { count, done, printProblems, projectRoot } from './command'

export const check: Command = {
  usage: 'check [dir] [-p tsconfig.json] [--entry <file>] [--deny-warnings] [--fix] [--only <group>]',
  options: { 'project': { type: 'string', short: 'p' }, 'entry': { type: 'string' }, 'deny-warnings': { type: 'boolean' }, 'fix': { type: 'boolean' }, 'only': { type: 'string' } },
  positionals: 1,
  run: async ({ values, positionals }) => {
    const { project, entry } = values
    const only = typeof values.only === 'string' ? values.only : undefined

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
    const { failing, found } = await checkProject(root, await loadConfig(root), typeof project === 'string' ? project : 'tsconfig.json', typeof entry === 'string' ? relative(root, resolve(entry)) : undefined, { denyWarnings: values['deny-warnings'] === true, fix: values.fix === true, only, launch: only === 'seo' })

    if (found === 0)
      done('checked', 'with no problems', performance.now() - started)

    return failing > 0 ? 1 : 0
  },
}

// Prints what `kay check` finds in the project and answers how many it found and how many of those fail it: the errors, and the warnings too with `denyWarnings`.
// With `fix`, applies the safe fixes first, then checks again and prints what is left; with `only`, prints that group's lints alone.
async function checkProject(root: string, config: KayConfig, tsconfig: string, entry: string | undefined, { denyWarnings, fix, only, launch }: { denyWarnings: boolean, fix: boolean, only: LintGroup | undefined, launch: boolean }): Promise<{ failing: number, found: number }> {
  const options = { ...configCheckOptions(config), tsconfig, entry, launch }
  let diagnostics = await checkTypes(root, options)
  const fixed = fix ? await applySafeFixes(root, diagnostics) : 0

  if (fixed > 0) {
    done('fixed', count(fixed, 'problem'))
    diagnostics = await checkTypes(root, options)
  }

  if (only !== undefined)
    diagnostics = diagnostics.filter(diagnostic => isLint(diagnostic.code) && LINTS[diagnostic.code].group === only)

  return printProblems(diagnostics, denyWarnings)
}
