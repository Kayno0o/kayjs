import type { Command } from './command'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configCheckOptions, writeShadowTypes } from '../check'
import { loadConfig } from '../config-loader'
import { buildingWithoutEnv } from '../server/env-state'
import { asksForHelp, printFailure, projectRoot, takeFormat } from './command'
import { dropStaleLintCache } from './lint-cache'

const HELP = `kay lint writes the types the lint of .kay files reads, drops an ESLint cache they made stale, then runs the project's keslint on every argument; its exit code is keslint's.
--format json prints ESLint's JSON document alone on stdout, a failure of kay's own as a kay problem document.

keslint's own help follows.
`

// Writes the types the lint of .kay files reads, then runs the project's `keslint` on the arguments, so linting needs no `kay check` before it.
export const lint: Command = {
  usage: 'lint [keslint arguments]...',
  options: { format: { type: 'string' } },
  positionals: Infinity,
  // Every argument is keslint's, `--fix` and `--help` included, but `--format json|text`.
  normalize: takeFormat,
  run: async ({ values, positionals }) => {
    const format = values.format === 'json' ? 'json' : 'text'
    const root = projectRoot('lint', '.', format)

    if (root === undefined)
      return 1

    const keslint = installedBin(root)

    if (keslint === undefined) {
      printFailure('lint', 'the project has no `keslint`: add `@kaynooo/eslint`', format)

      return 1
    }

    if (asksForHelp(positionals)) {
      // Under --format json stdout holds what keslint prints alone.
      if (format === 'json')
        console.error(HELP)
      else
        console.log(HELP)

      return Bun.spawn([keslint, '--help'], { stdio: ['inherit', 'inherit', 'inherit'] }).exited
    }

    buildingWithoutEnv()

    try {
      await writeShadowTypes(root, configCheckOptions(await loadConfig(root)))
    }
    catch (error) {
      printFailure('lint', error, format)

      return 1
    }

    await dropStaleLintCache(root, positionals)

    return Bun.spawn([keslint, ...format === 'json' ? ['--format', 'json'] : [], ...positionals], { stdio: ['inherit', 'inherit', 'inherit'] }).exited
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
