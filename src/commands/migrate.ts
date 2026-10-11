import type { Command } from './command'
import { statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { colors } from '@kaynooo/utils/tools/colors'
import { migrateAstroProject } from '../migrate/project'
import { count, done, shellQuote } from './command'

// Translates an Astro project's `.astro` files and content config, in place or into `--out`, a directory with no package.json getting the kay project around them, and lists what is left to do by hand.
export const migrate: Command = {
  usage: 'migrate astro [dir] [--out <dir>]',
  options: { out: { type: 'string' } },
  positionals: 2,
  run: async ({ values, positionals }) => {
    const [from, dir = '.'] = positionals

    if (from !== 'astro') {
      console.error(`kay migrate: ${from === undefined ? 'name what to migrate from' : `${from} is not something kay migrates from`}, as in \`kay migrate astro\``)

      return 1
    }

    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      console.error(`kay migrate: ${dir} is not a directory`)

      return 1
    }

    const out = typeof values.out === 'string' ? resolve(values.out) : resolve(dir)
    const { written, copied, skipped, notes } = await migrateAstroProject(resolve(dir), out)
    const shown = (file: string) => relative(process.cwd(), join(out, file)) || '.'

    for (const file of written)
      done('wrote', shown(file))

    for (const file of skipped)
      console.log(`${colors.bold.yellow('kept')} ${shown(file)}, which exists`)

    if (copied.length > 0)
      done('copied', `${count(copied.length, 'other file')} of src and public`)

    if (notes.length > 0)
      console.log(`\nLeft to do by hand, the code it concerns marked \`kay migrate:\` where it was commented out:\n${notes.map(each => `${relative(process.cwd(), join(dir, each.file))}:${each.line}${each.target === undefined ? '' : ` (${shown(each.target)})`}: ${each.message}`).join('\n')}`)

    console.log(`\n${count(written.length, 'file')} written, ${count(notes.length, 'item')} left to do by hand`)

    if (written.includes('package.json'))
      console.log(`\n  ${colors.cyan(`cd ${shellQuote(relative(process.cwd(), out) || '.')} && bun install && bun run dev`)}`)

    return 0
  },
}
