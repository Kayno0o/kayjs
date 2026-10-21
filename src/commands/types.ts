import type { Command } from './command'
import { configCheckOptions, writeShadowTypes } from '../check'
import { loadConfig } from '../config'
import { buildingWithoutEnv } from '../server/env-state'
import { count, done, formatOption, printDocument, printFailure, projectRoot } from './command'
import { USAGES } from './usages'

// Writes `.kay/types`, which the language server, `kay lint` and the editor's ESLint read, without checking anything.
export const types: Command = {
  usage: USAGES.types,
  options: { format: { type: 'string' }, quiet: { type: 'boolean' } },
  positionals: 1,
  run: async ({ values, positionals: [dir] }) => {
    const format = formatOption('types', values.format)

    if (format === undefined)
      return 1

    const root = projectRoot('types', dir, format)

    if (root === undefined)
      return 1

    buildingWithoutEnv()

    try {
      const { files } = await writeShadowTypes(root, configCheckOptions(await loadConfig(root)))

      if (format === 'json')
        printDocument({ files: files.size, dir: '.kay/types' })
      else if (values.quiet !== true)
        done('wrote', `${count(files.size, 'type file')} to .kay/types`)

      return 0
    }
    catch (error) {
      printFailure('types', error, format)

      return 1
    }
  },
}
