import type { Command } from './command'
import { resolve } from 'node:path'
import { generate } from '../generate'
import { count, done, formatOption, printDocument, reportFailure } from './command'
import { USAGES } from './usages'

export const generateCommand: Command = {
  usage: USAGES.generate,
  options: { 'dir': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'format': { type: 'string' }, 'plural': { type: 'string' }, 'quiet': { type: 'boolean' } },
  positionals: Infinity,
  run: async ({ values, positionals: [kind, name, ...rest] }, refuse) => {
    const format = formatOption('generate', values.format)

    if (kind === undefined || name === undefined)
      return refuse()

    if (format === undefined)
      return 1

    // A resource takes every argument after its name as a field, the project folder being `--dir`; every other kind takes the folder as its one argument or `--dir`, the cwd otherwise.
    const fields = kind === 'resource' ? rest : []
    const [folder, ...extra] = kind === 'resource' ? [] : rest

    if (extra.length > 0)
      return refuse(`unexpected argument ${extra[0]}`)

    if (folder !== undefined && values.dir !== undefined)
      return refuse('the project folder is given once: as the argument or as --dir')

    const dir = folder ?? (typeof values.dir === 'string' ? values.dir : '.')

    if (values.plural !== undefined && kind !== 'resource')
      return refuse('--plural is for a resource')

    const dryRun = values['dry-run'] === true

    try {
      const { written } = await generate(resolve(dir), kind, name, { dryRun, fields, plural: typeof values.plural === 'string' ? values.plural : undefined })

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
