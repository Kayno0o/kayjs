import type { Command } from './command'
import { configCheckOptions, writeShadowTypes } from '../check'
import { loadConfig } from '../config'
import { buildingWithoutEnv } from '../server/env-state'
import { count, done, printFailure, projectRoot } from './command'
import { USAGES } from './usages'

// Writes `.kay/types`, which the language server, `kay lint` and the editor's ESLint read, without checking anything.
export const types: Command = {
  usage: USAGES.types,
  options: { quiet: { type: 'boolean' } },
  positionals: 1,
  run: async ({ values, positionals: [dir] }) => {
    const root = projectRoot('types', dir)

    if (root === undefined)
      return 1

    buildingWithoutEnv()

    try {
      const { files } = await writeShadowTypes(root, configCheckOptions(await loadConfig(root)))

      if (values.quiet !== true)
        done('wrote', `${count(files.size, 'type file')} to .kay/types`)

      return 0
    }
    catch (error) {
      printFailure('types', error, 'text')

      return 1
    }
  },
}
