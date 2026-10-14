import type { Command } from './command'
import { statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { colors } from '@kaynooo/utils/tools/colors'
import { migrateAstroProject } from '../migrate/project'
import { count, done, formatOption, printDocument, printFailure, shellQuote } from './command'

// Translates an Astro project's `.astro` files and content config, in place or into `--out`, a directory with no package.json getting the kay project around them, and lists what is left to do by hand.
export const migrate: Command = {
  usage: 'migrate astro [dir] [--out <dir>] [--format text|json] [--quiet]',
  options: { out: { type: 'string' }, format: { type: 'string' }, quiet: { type: 'boolean' } },
  positionals: 2,
  run: async ({ values, positionals }) => {
    const [from, dir = '.'] = positionals
    const format = formatOption('migrate', values.format)

    if (format === undefined)
      return 1

    if (from !== 'astro') {
      printFailure('migrate', `${from === undefined ? 'name what to migrate from' : `${from} is not something kay migrates from`}, as in \`kay migrate astro\``, format)

      return 1
    }

    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      printFailure('migrate', `${dir} is not a directory`, format)

      return 1
    }

    const out = typeof values.out === 'string' ? resolve(values.out) : resolve(dir)
    let migrated: Awaited<ReturnType<typeof migrateAstroProject>>

    try {
      migrated = await migrateAstroProject(resolve(dir), out)
    }
    catch (error) {
      printFailure('migrate', error, format)

      return 1
    }

    const { written, copied, skipped, notes } = migrated
    const shown = (file: string) => relative(process.cwd(), join(out, file)) || '.'
    const noted = notes.map(each => ({ file: relative(process.cwd(), join(dir, each.file)), line: each.line, ...each.target !== undefined && { target: shown(each.target) }, message: each.message }))

    if (format === 'json') {
      printDocument({ written: written.map(shown), kept: skipped.map(shown), copied: copied.length, notes: noted })

      return 0
    }

    // Quiet, what is left to do and the count alone.
    const quiet = values.quiet === true

    if (!quiet) {
      for (const file of written)
        done('wrote', shown(file))

      for (const file of skipped)
        console.log(`${colors.bold.yellow('kept')} ${shown(file)}, which exists`)

      if (copied.length > 0)
        done('copied', `${count(copied.length, 'other file')} of src and public`)
    }

    if (noted.length > 0)
      console.log(`\nLeft to do by hand, the code it concerns marked \`kay migrate:\` where it was commented out:\n${noted.map(each => `${each.file}:${each.line}${each.target === undefined ? '' : ` (${each.target})`}: ${each.message}`).join('\n')}`)

    console.log(`\n${count(written.length, 'file')} written, ${count(notes.length, 'item')} left to do by hand`)

    if (written.includes('package.json') && !quiet)
      console.log(`\n  ${colors.cyan(`cd ${shellQuote(relative(process.cwd(), out) || '.')} && bun install && bun run dev`)}`)

    return 0
  },
}
