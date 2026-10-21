import type { Feature, Host, Preset } from '../new'
import type { Command, Parsed } from './command'
import process from 'node:process'
import { colors } from '@kaynooo/utils/tools/colors'
import { createProject, detectHost, FEATURE_NAMES, HOSTS, pickFeatures, PRESET_NAMES, PRESETS, refuseTarget } from '../new'
import { count, done, failureProblem, formatOption, printDocument, shellQuote } from './command'
import { USAGES } from './usages'

export const scaffold: Command = {
  usage: USAGES.new,
  options: { 'kay': { type: 'string' }, 'template': { type: 'string' }, 'with': { type: 'string' }, 'forge': { type: 'string' }, 'host': { type: 'string' }, 'runner': { type: 'string' }, 'without': { type: 'string' }, 'yes': { type: 'boolean', short: 'y' }, 'dry-run': { type: 'boolean' }, 'format': { type: 'string' }, 'quiet': { type: 'boolean' } },
  positionals: 1,
  run: async ({ values, positionals: [dir] }, refuse) => {
    const format = formatOption('new', values.format)

    if (dir === undefined || dir === '')
      return refuse()

    if (format === undefined)
      return 1

    try {
      const { template, with: added, without: removed, yes } = values
      const dryRun = values['dry-run'] === true

      if (template !== undefined && !PRESET_NAMES.includes(template as Preset)) {
        console.error(`kay new: --template is ${String(template)}, which is none of ${PRESET_NAMES.join(', ')}`)

        return 1
      }

      // `--host` named the forge before `kay dev --host` named an address: it still works, saying so.
      if (values.host !== undefined && values.forge === undefined && values.quiet !== true)
        console.error('kay new: --host is now --forge (kay dev --host is an address); --host still works until 1.73')

      const forge = values.forge ?? values.host

      if (forge !== undefined && !HOSTS.includes(forge as Host)) {
        console.error(`kay new: --${values.forge === undefined ? 'host' : 'forge'} is ${String(forge)}, which is none of ${HOSTS.join(', ')}`)

        return 1
      }

      const listed = (list: Parsed['values'][string]) => typeof list === 'string' ? list.split(',').map(name => name.trim()).filter(name => name !== '') : []
      const unknown = [...listed(added), ...listed(removed)].find(name => !FEATURE_NAMES.includes(name as Feature))

      if (unknown !== undefined) {
        console.error(`kay new: ${unknown} is none of the features ${FEATURE_NAMES.join(', ')}`)

        return 1
      }

      const both = listed(added).find(name => listed(removed).includes(name))

      if (both !== undefined) {
        console.error(`kay new: ${both} is in both --with and --without`)

        return 1
      }

      await refuseTarget(dir)

      // With no option saying what to scaffold, a terminal asks; anything else takes the preset, the server's by default, with what --with and --without change.
      const ask = template === undefined && added === undefined && removed === undefined && yes !== true && process.stdin.isTTY && process.stderr.isTTY
      const chosen = new Set(PRESETS[(template as Preset | undefined) ?? 'server'].features)

      for (const name of listed(added))
        chosen.add(name as Feature)

      for (const name of listed(removed))
        chosen.delete(name as Feature)

      const features = ask ? await pickFeatures() : [...chosen]

      if (features === undefined) {
        console.error('kay new: cancelled, nothing written')

        return 1
      }

      const files = await createProject(dir, { kay: typeof values.kay === 'string' ? values.kay : undefined, features, host: forge === undefined ? await detectHost(dir) : forge as Host, runner: typeof values.runner === 'string' ? values.runner : undefined, dryRun })

      if (format === 'json') {
        printDocument({ dir, features, files, dryRun })

        return 0
      }

      done(dryRun ? 'would create' : 'created', `${dir}, ${features.length > 0 ? features.join(', ') : 'blank'}, ${count(files.length, 'file')}`)

      if (dryRun && values.quiet !== true) {
        for (const path of files)
          console.log(`  ${path}`)

        return 0
      }

      // With Postgres, the database runs in the container its compose.dev.yaml describes, migrated before the first start; SQLite is a file, which `bun run dev` migrates.
      if (values.quiet !== true)
        console.log(`\n  ${colors.cyan(`cd ${shellQuote(dir)} && bun install && ${features.includes('postgres') ? 'docker compose up -d --wait && bun run db:migrate && ' : ''}bun run dev`)}`)

      return 0
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      console.error(message)

      if (format === 'json')
        printDocument({ errors: 1, warnings: 0, problems: [failureProblem(message, format)] })

      return 1
    }
  },
}
