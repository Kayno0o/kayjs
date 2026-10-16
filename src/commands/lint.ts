import type { Command } from './command'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { configCheckOptions, writeShadowTypes } from '../check'
import { loadConfig } from '../config'
import { buildingWithoutEnv } from '../server/env-state'
import { printFailure, projectRoot } from './command'
import { USAGES } from './usages'

// Writes the types the lint of .kay files reads, then runs the project's `keslint` on the arguments, so linting needs no `kay check` before it.
export const lint: Command = {
  usage: USAGES.lint,
  options: {},
  positionals: Infinity,
  // Every argument is keslint's, `--fix` and `--help` included.
  normalize: args => ['--', ...args],
  run: async ({ positionals }) => {
    const root = projectRoot('lint')

    if (root === undefined)
      return 1

    const keslint = Bun.which('keslint', { PATH: `${join(root, 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}` })

    if (keslint === null) {
      printFailure('lint', 'the project has no `keslint`: add `@kaynooo/eslint`', 'text')

      return 1
    }

    buildingWithoutEnv()

    try {
      await writeShadowTypes(root, configCheckOptions(await loadConfig(root)))
    }
    catch (error) {
      printFailure('lint', error, 'text')

      return 1
    }

    return Bun.spawn([keslint, ...positionals], { stdio: ['inherit', 'inherit', 'inherit'] }).exited
  },
}
