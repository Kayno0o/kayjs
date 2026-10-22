import type { Command } from './command'
import { resolve } from 'node:path'
import { generate } from '../generate'
import { count, done, formatOption, printDocument, reportFailure } from './command'
import { USAGES } from './usages'

export const generateCommand: Command = {
  usage: USAGES.generate,
  options: { 'dry-run': { type: 'boolean' }, 'format': { type: 'string' }, 'quiet': { type: 'boolean' } },
  positionals: Infinity,
  run: async ({ values, positionals: [kind, name, ...rest] }, refuse) => {
    const format = formatOption('generate', values.format)

    if (kind === undefined || name === undefined)
      return refuse()

    if (format === undefined)
      return 1

    // A resource takes its fields as `name:type`, then the project folder; every other kind takes the folder alone.
    const fields = kind === 'resource' ? rest.filter(argument => argument.includes(':')) : []
    const [dir = '.', ...extra] = kind === 'resource' ? rest.filter(argument => !argument.includes(':')) : rest

    if (extra.length > 0)
      return refuse(`unexpected argument ${extra[0]}`)

    const dryRun = values['dry-run'] === true

    try {
      const { written } = await generate(resolve(dir), kind, name, { dryRun, fields })

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
