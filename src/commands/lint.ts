import type { Command } from './command'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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

    // Only the project's own, as kay resolves its other dependencies.
    const keslint = join(root, 'node_modules/.bin/keslint')

    if (!existsSync(keslint)) {
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
