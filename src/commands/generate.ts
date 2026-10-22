import type { Command } from './command'
import { resolve } from 'node:path'
import { generate } from '../generate'
import { count, done, formatOption, printDocument, reportFailure } from './command'
import { USAGES } from './usages'

export const generateCommand: Command = {
  usage: USAGES.generate,
  options: { 'dry-run': { type: 'boolean' }, 'format': { type: 'string' }, 'quiet': { type: 'boolean' } },
  positionals: 3,
  run: async ({ values, positionals: [kind, name, dir = '.'] }, refuse) => {
    const format = formatOption('generate', values.format)

    if (kind === undefined || name === undefined)
      return refuse()

    if (format === undefined)
      return 1

    const dryRun = values['dry-run'] === true

    try {
      const { written } = await generate(resolve(dir), kind, name, { dryRun })

      if (format === 'json') {
        printDocument({ kind, name, written, dryRun })

        return 0
      }

      done(dryRun ? 'would generate' : 'generated', `${kind} ${name}, ${count(written.length, 'file')} ${dryRun ? 'to write' : 'written'}`)

      if (values.quiet !== true) {
        for (const path of written)
          console.log(`  ${path}`)
      }

      return 0
    }
    catch (error) {
      reportFailure(error instanceof Error ? error.message : String(error), format)

      return 1
    }
  },
}
