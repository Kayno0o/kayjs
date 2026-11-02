import type { Editor, EditorSetup } from '../editors'
import type { Feature, Host, Preset } from '../new'
import type { Command, Parsed } from './command'
import process from 'node:process'
import { confirm } from '@kaynooo/cli-kit/prompt'
import { colors } from '@kaynooo/utils/tools/colors'
import { EDITORS, findEditors, installEditor } from '../editors'
import { createProject, detectHost, FEATURE_NAMES, HOSTS, pickFeatures, PRESET_NAMES, PRESETS, refuseTarget } from '../new'
import { count, done, formatOption, printDocument, reportFailure, shellQuote } from './command'

export const scaffold: Command = {
  usage: 'new <dir> [--kay <dependency>] [--template blank|server|site|app] [--with <features>] [--without <features>] [--editor helix,zed|none] [--forge forgejo|github] [--runner <label>] [-y] [--dry-run] [--format text|json] [--quiet]',
  options: { 'kay': { type: 'string' }, 'template': { type: 'string' }, 'with': { type: 'string' }, 'forge': { type: 'string' }, 'editor': { type: 'string' }, 'runner': { type: 'string' }, 'without': { type: 'string' }, 'yes': { type: 'boolean', short: 'y' }, 'dry-run': { type: 'boolean' }, 'format': { type: 'string' }, 'quiet': { type: 'boolean' } },
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
        reportFailure(`kay new: --template is ${String(template)}, which is none of ${PRESET_NAMES.join(', ')}`, format)

        return 1
      }

      const { forge } = values

      if (forge !== undefined && !HOSTS.includes(forge as Host)) {
        reportFailure(`kay new: --forge is ${String(forge)}, which is none of ${HOSTS.join(', ')}`, format)

        return 1
      }

      const listed = (list: Parsed['values'][string]) => typeof list === 'string' ? list.split(',').map(name => name.trim()).filter(name => name !== '') : []
      const unknown = [...listed(added), ...listed(removed)].find(name => !FEATURE_NAMES.includes(name as Feature))

      if (unknown !== undefined) {
        reportFailure(`kay new: ${unknown} is none of the features ${FEATURE_NAMES.join(', ')}`, format)

        return 1
      }

      const both = listed(added).find(name => listed(removed).includes(name))

      if (both !== undefined) {
        reportFailure(`kay new: ${both} is in both --with and --without`, format)

        return 1
      }

      const wanted = listed(values.editor)
      const unknownEditor = wanted.find(name => name !== 'none' && !EDITORS.includes(name as Editor))

      if (unknownEditor !== undefined) {
        reportFailure(`kay new: --editor is ${unknownEditor}, which is none of ${EDITORS.join(', ')}, none`, format)

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
        reportFailure('kay new: cancelled, nothing written', format)

        return 1
      }

      const files = await createProject(dir, { kay: typeof values.kay === 'string' ? values.kay : undefined, features, host: forge === undefined ? await detectHost(dir) : forge as Host, runner: typeof values.runner === 'string' ? values.runner : undefined, dryRun })

      const editors = dryRun ? [] : await setUpEditors(dir, wanted.filter(name => name !== 'none') as Editor[], values.editor === undefined && yes !== true && format === 'text' && process.stdin.isTTY && process.stderr.isTTY)

      if (format === 'json') {
        printDocument({ dir, features, files, dryRun, editors })

        return 0
      }

      done(dryRun ? 'would create' : 'created', `${dir}, ${features.length > 0 ? features.join(', ') : 'blank'}, ${count(files.length, 'file')}`)

      for (const { summary, notes } of editors) {
        console.log(summary)

        for (const note of notes)
          process.stderr.write(`  ${note}\n`)
      }

      if (dryRun && values.quiet !== true) {
        for (const path of files)
          console.log(`  ${path}`)

        return 0
      }

      // With Postgres, the database runs in the container its compose.dev.yaml describes, with kayjs-auth's first migration generated and applied before the first start; SQLite is a file kayjs-auth creates itself.
      if (values.quiet !== true)
        console.log(`\n  ${colors.cyan(`cd ${shellQuote(dir)} && bun install && ${features.includes('postgres') ? 'docker compose up -d --wait && bun run db:generate init && bun run db:migrate && ' : ''}bun run dev`)}`)

      return 0
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      reportFailure(message, format)

      return 1
    }
  },
}

// The editors the project is set up for: the ones --editor names, else, in a terminal, those on the PATH once the user agrees; a failure is said and does not undo the scaffold.
async function setUpEditors(dir: string, named: Editor[], mayAsk: boolean): Promise<EditorSetup[]> {
  let editors = named

  if (mayAsk) {
    editors = findEditors()

    if (editors.length === 0 || !await confirm(`Set up ${editors.join(' and ')} for .kay files and the language server?`, { default: true }))
      return []
  }

  const setups: EditorSetup[] = []

  for (const editor of editors) {
    try {
      setups.push(await installEditor(editor, { root: dir, installing: true }))
    }
    catch (error) {
      console.error(`kay new: ${editor} was not set up: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return setups
}
