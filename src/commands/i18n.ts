import type { I18nConfig, KayConfig } from '../config'
import type { Command } from './command'
import { existsSync } from 'node:fs'
import { relative } from 'node:path'
import process from 'node:process'
import { loadConfig } from '../config'
import { buildingWithoutEnv } from '../server/env-state'
import { messagesFile } from '../server/i18n'
import { acceptDrafts } from '../server/message-drafts'
import { missingTranslations } from '../server/translations'
import { count, done, formatOption, printDocument, printFailure, projectRoot, withStdoutOnStderr } from './command'
import { USAGES } from './usages'

// What each locale lacks against the default locale: message keys, its extensions' included, and the entries of its localized collections.
export const i18nMissing: Command = {
  usage: USAGES['i18n missing'],
  options: { format: { type: 'string' } },
  positionals: 2,
  run: async ({ values, positionals: [wanted, path] }) => {
    const format = formatOption('i18n missing', values.format)

    if (format === undefined)
      return 1

    const project = await translated('i18n missing', path, format)

    if (project === undefined)
      return 1

    const { root, config, i18n } = project

    if (wanted !== undefined && (!i18n.locales.includes(wanted) || wanted === i18n.defaultLocale)) {
      printFailure('i18n missing', `${wanted} is not one of the locales translated from ${i18n.defaultLocale}: ${i18n.locales.filter(code => code !== i18n.defaultLocale).join(', ')}`, format)

      return 1
    }

    try {
      const missing = await withStdoutOnStderr(async () => missingTranslations(root, config))
      const shown = Object.entries(missing).filter(([locale]) => wanted === undefined || locale === wanted)

      if (format === 'json') {
        printDocument({ locales: Object.fromEntries(shown.map(([locale, { messages, entries }]) => [locale, { messages: Object.keys(messages), entries }])) })

        return 0
      }

      for (const [locale, { messages, entries }] of shown) {
        const keys = Object.keys(messages)
        const lines = [
          ...keys.length > 0 ? [`${locale} lacks ${count(keys.length, 'message')}: ${keys.join(', ')}`] : [],
          ...Object.entries(entries).map(([name, slugs]) => `${locale} lacks ${slugs.length} ${slugs.length === 1 ? 'entry' : 'entries'} of ${name}: ${slugs.join(', ')}`),
        ]

        console.log(lines.length === 0 ? `${locale} lacks nothing` : lines.join('\n'))
      }

      return 0
    }
    catch (error) {
      printFailure('i18n missing', error, format)

      return 1
    }
  },
}

// Deletes the `// draft` comment of every message of a locale's file, a person having checked them.
export const i18nAccept: Command = {
  usage: USAGES['i18n accept'],
  options: { 'dry-run': { type: 'boolean' } },
  positionals: 2,
  run: async ({ values, positionals: [locale, path] }, refuse) => {
    if (locale === undefined)
      return refuse('i18n accept needs the locale whose drafts to accept')

    const project = await translated('i18n accept', path, 'text')

    if (project === undefined)
      return 1

    const { root, i18n } = project

    if (!i18n.locales.includes(locale)) {
      printFailure('i18n accept', `${locale} is not one of the locales i18n lists: ${i18n.locales.join(', ')}`, 'text')

      return 1
    }

    const file = messagesFile(root, i18n, locale)
    const shown = relative(process.cwd(), file)

    if (!existsSync(file)) {
      printFailure('i18n accept', `${shown} does not exist, so it holds no draft`, 'text')

      return 1
    }

    const { source, accepted } = acceptDrafts(await Bun.file(file).text())

    if (accepted === 0) {
      console.log(`${shown} holds no draft`)

      return 0
    }

    if (values['dry-run'] === true) {
      done('Would accept', `${count(accepted, 'draft')} in ${shown}`)

      return 0
    }

    await Bun.write(file, source)
    done('Accepted', `${count(accepted, 'draft')} in ${shown}`)

    return 0
  },
}

// The project and its `i18n`, or nothing once said why there is none.
async function translated(command: string, path: string | undefined, format: 'text' | 'github' | 'json'): Promise<{ root: string, config: KayConfig, i18n: I18nConfig } | undefined> {
  const root = projectRoot(command, path, format)

  if (root === undefined)
    return undefined

  buildingWithoutEnv()

  let config: KayConfig

  try {
    config = await loadConfig(root)
  }
  catch (error) {
    printFailure(command, error, format)

    return undefined
  }

  if (!config.i18n) {
    printFailure(command, 'kay.config.ts sets no i18n, so the site has no locale to translate', format)

    return undefined
  }

  return { root, config, i18n: config.i18n }
}
