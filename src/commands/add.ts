import type { Command } from './command'
import { resolve } from 'node:path'
import { addFeatures } from '../add'
import { count, done } from './command'
import { USAGES } from './usages'

export const add: Command = {
  usage: USAGES.add,
  options: { 'no-install': { type: 'boolean' }, 'quiet': { type: 'boolean' } },
  positionals: 2,
  run: async ({ values, positionals: [features, dir = '.'] }, refuse) => {
    const names = [...new Set((features ?? '').split(',').map(name => name.trim()).filter(name => name !== ''))]

    if (names.length === 0)
      return refuse()

    try {
      const { written, installed, notes } = await addFeatures(resolve(dir), names, { install: values['no-install'] !== true })

      done('added', `${names.join(', ')}, ${count(written.length, 'file')} written${installed ? ', dependencies installed' : ''}`)

      if (values.quiet !== true) {
        for (const path of written)
          console.log(`  ${path}`)

        for (const note of notes)
          console.log(`\n  ${note}`)
      }

      return 0
    }
    catch (error) {
      console.error(error instanceof Error ? error.message : error)

      return 1
    }
  },
}
