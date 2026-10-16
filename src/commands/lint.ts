import type { Command } from './command'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

    const keslint = installedBin(root)

    if (keslint === undefined) {
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

// The first `node_modules/.bin/keslint` from the project up, as a package manager resolves a dependency: a workspace member's bins are hoisted to the workspace root.
function installedBin(from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const bin = join(dir, 'node_modules/.bin/keslint')

    if (existsSync(bin))
      return bin

    if (dirname(dir) === dir)
      return undefined
  }
}
