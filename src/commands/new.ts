import type { Feature, Preset } from '../new'
import type { Command, Parsed } from './command'
import process from 'node:process'
import { colors } from '@kaynooo/utils/tools/colors'
import { createProject, FEATURE_NAMES, pickFeatures, PRESET_NAMES, PRESETS, refuseTarget } from '../new'
import { count, done, shellQuote } from './command'
import { USAGES } from './usages'

export const scaffold: Command = {
  usage: USAGES.new,
  options: { kay: { type: 'string' }, template: { type: 'string' }, with: { type: 'string' }, without: { type: 'string' }, yes: { type: 'boolean', short: 'y' }, quiet: { type: 'boolean' } },
  positionals: 1,
  run: async ({ values, positionals: [dir] }, refuse) => {
    if (dir === undefined || dir === '')
      return refuse()

    try {
      const { template, with: added, without: removed, yes } = values

      if (template !== undefined && !PRESET_NAMES.includes(template as Preset)) {
        console.error(`kay new: --template is ${String(template)}, which is none of ${PRESET_NAMES.join(', ')}`)

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

      const files = await createProject(dir, { kay: typeof values.kay === 'string' ? values.kay : undefined, features })

      done('created', `${dir}, ${features.length > 0 ? features.join(', ') : 'blank'}, ${count(files.length, 'file')}`)

      // An app's database runs in the container its compose.dev.yaml describes, migrated before the first start.
      if (values.quiet !== true)
        console.log(`\n  ${colors.cyan(`cd ${shellQuote(dir)} && bun install && ${features.includes('auth') ? 'docker compose up -d --wait && bun run db:migrate && ' : ''}bun run dev`)}`)

      return 0
    }
    catch (error) {
      console.error(error instanceof Error ? error.message : error)

      return 1
    }
  },
}
