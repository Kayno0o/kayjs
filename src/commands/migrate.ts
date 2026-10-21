import type { RewrittenCollection } from '../content/rewrite'
import type { Command, ProblemFormat } from './command'
import { statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { colors } from '@kaynooo/utils/tools/colors'
import { migrateAstroProject } from '../migrate/project'
import { buildingWithoutEnv } from '../server/env-state'
import { count, done, formatOption, printDocument, printFailure, shellQuote } from './command'
import { USAGES } from './usages'

// `kay migrate astro` translates an Astro project's `.astro` files and content config, in place or into `--outdir` (`--out` as before), a directory with no package.json getting the kay project around them, and lists what is left to do by hand; `kay migrate content` rewrites the entry files of the folder collections whose `migrations` carried them to the schema's shape.
export const migrate: Command = {
  usage: USAGES.migrate,
  options: { 'outdir': { type: 'string' }, 'out': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'format': { type: 'string' }, 'quiet': { type: 'boolean' } },
  positionals: 2,
  run: async ({ values, positionals }) => {
    const [from, dir = '.'] = positionals
    const format = formatOption('migrate', values.format)

    if (format === undefined)
      return 1

    if (from !== 'astro' && from !== 'content') {
      printFailure('migrate', `${from === undefined ? 'name what to migrate' : `${from} is not something kay migrates`}, as in \`kay migrate astro\` or \`kay migrate content\``, format)

      return 1
    }

    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      printFailure('migrate', `${dir} is not a directory`, format)

      return 1
    }

    if (from === 'content') {
      if (values.outdir !== undefined || values.out !== undefined) {
        printFailure('migrate', 'kay migrate content rewrites the entry files in place and takes no --outdir or --out', format)

        return 1
      }

      return migrateContent(resolve(dir), format, values.quiet === true, values['dry-run'] === true)
    }

    if (typeof values.out === 'string' && typeof values.outdir === 'string' && resolve(values.out) !== resolve(values.outdir)) {
      printFailure('migrate', '--out is the older spelling of --outdir, and the two name different directories; keep --outdir', format)

      return 1
    }

    if (typeof values.out === 'string' && values.outdir === undefined && values.quiet !== true)
      console.error('kay migrate: --out is now --outdir; --out still works until 1.73')

    const outdir = values.outdir ?? values.out
    const dryRun = values['dry-run'] === true
    const out = typeof outdir === 'string' ? resolve(outdir) : resolve(dir)
    let migrated: Awaited<ReturnType<typeof migrateAstroProject>>

    try {
      migrated = await migrateAstroProject(resolve(dir), out, { dryRun })
    }
    catch (error) {
      printFailure('migrate', error, format)

      return 1
    }

    const { written, copied, skipped, notes } = migrated
    const shown = (file: string) => relative(process.cwd(), join(out, file)) || '.'
    const noted = notes.map(each => ({ file: relative(process.cwd(), join(dir, each.file)), line: each.line, ...each.target !== undefined && { target: shown(each.target) }, message: each.message }))

    if (format === 'json') {
      printDocument({ dryRun, written: written.map(shown), kept: skipped.map(shown), copied: copied.length, notes: noted })

      return 0
    }

    // Quiet, what is left to do and the count alone.
    const quiet = values.quiet === true

    if (!quiet) {
      for (const file of written)
        done(dryRun ? 'would write' : 'wrote', shown(file))

      for (const file of skipped)
        console.log(`${colors.bold.yellow('kept')} ${shown(file)}, which exists`)

      if (copied.length > 0)
        done('copied', `${count(copied.length, 'other file')} of src and public`)
    }

    if (noted.length > 0)
      console.log(`\nLeft to do by hand, the code it concerns marked \`kay migrate:\` where it was commented out:\n${noted.map(each => `${each.file}:${each.line}${each.target === undefined ? '' : ` (${each.target})`}: ${each.message}`).join('\n')}`)

    console.log(`\n${count(written.length, 'file')} ${dryRun ? 'to write' : 'written'}, ${count(notes.length, 'item')} left to do by hand`)

    if (written.includes('package.json') && !quiet && !dryRun)
      console.log(`\n  ${colors.cyan(`cd ${shellQuote(relative(process.cwd(), out) || '.')} && bun install && bun run dev`)}`)

    return 0
  },
}

// Rewrites the files of the folder collections that declare `migrations`, which `kay build` and the server only migrate as they read.
async function migrateContent(root: string, format: ProblemFormat, quiet: boolean, dryRun: boolean): Promise<number> {
  buildingWithoutEnv()

  let migrated: { collections: RewrittenCollection[], declared: number }

  try {
    migrated = await (await import('../content/rewrite')).migrateFolders(root, !dryRun)
  }
  catch (error) {
    printFailure('migrate', error, format)

    return 1
  }

  const { collections, declared } = migrated
  const rewritten = collections.flatMap(each => each.rewritten)
  const failed = collections.flatMap(each => each.failed)

  if (format === 'json') {
    printDocument({ rewritten, failed, dryRun })

    return failed.length > 0 ? 1 : 0
  }

  if (!quiet) {
    for (const file of rewritten)
      done(dryRun ? 'would rewrite' : 'rewrote', relative(process.cwd(), join(root, file)))
  }

  for (const { file, message } of failed)
    console.error(`${colors.bold.red('failed')} ${relative(process.cwd(), join(root, file))}: ${message}`)

  console.log(declared === 0 ? 'no folder collection declares `migrations`' : `${count(rewritten.length, 'file')} ${dryRun ? 'to rewrite' : 'rewritten'}${failed.length > 0 ? `, ${failed.length} failed` : ''}`)

  return failed.length > 0 ? 1 : 0
}
