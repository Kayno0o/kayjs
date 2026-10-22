import type { Command } from './command'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { generate } from '../generate'
import { count, done, formatOption, printDocument, reportFailure } from './command'
import { USAGES } from './usages'

const PATH_LIKE = /[./\\]/

export const generateCommand: Command = {
  usage: USAGES.generate,
  options: { 'dry-run': { type: 'boolean' }, 'format': { type: 'string' }, 'plural': { type: 'string' }, 'quiet': { type: 'boolean' } },
  positionals: Infinity,
  run: async ({ values, positionals: [kind, name, ...rest] }, refuse) => {
    const format = formatOption('generate', values.format)

    if (kind === undefined || name === undefined)
      return refuse()

    if (format === undefined)
      return 1

    // A resource takes its fields as `name:type`, then the project folder, the last argument when it is no field: one with a path separator or a dot, or an existing folder, so a field written without its type is reported as one. Every other kind takes the folder alone.
    const last = rest.at(-1)
    const folder = kind === 'resource' && last !== undefined && !last.includes(':') && (PATH_LIKE.test(last) || existsSync(resolve(last))) ? 1 : 0
    const fields = kind === 'resource' ? rest.slice(0, rest.length - folder) : []
    const [dir = '.', ...extra] = kind === 'resource' ? rest.slice(rest.length - folder) : rest

    if (extra.length > 0)
      return refuse(`unexpected argument ${extra[0]}`)

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
