import type { Command } from './command'
import { resolve } from 'node:path'
import { addFeatures } from '../add'
import { count, done, formatOption, printDocument, reportFailure } from './command'
import { USAGES } from './usages'

export const add: Command = {
  usage: USAGES.add,
  options: { 'no-install': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'format': { type: 'string' }, 'quiet': { type: 'boolean' } },
  positionals: 2,
  run: async ({ values, positionals: [features, dir = '.'] }, refuse) => {
    const names = [...new Set((features ?? '').split(',').map(name => name.trim()).filter(name => name !== ''))]
    const format = formatOption('add', values.format)

    if (names.length === 0)
      return refuse()

    if (format === undefined)
      return 1

    const dryRun = values['dry-run'] === true

    try {
      const { written, installed, notes } = await addFeatures(resolve(dir), names, { install: values['no-install'] !== true, dryRun })

      if (format === 'json') {
        printDocument({ features: names, written, installed, notes, dryRun })

        return 0
      }

      done(dryRun ? 'would add' : 'added', `${names.join(', ')}, ${count(written.length, 'file')} ${dryRun ? 'to write' : 'written'}${installed ? ', dependencies installed' : ''}`)

      if (values.quiet !== true) {
        for (const path of written)
          console.log(`  ${path}`)

        for (const note of notes)
          console.log(`\n  ${note}`)
      }

      return 0
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      reportFailure(message, format)

      return 1
    }
  },
}
