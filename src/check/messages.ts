import type { I18nConfig, KayExtension } from '../config'
import type { ContentProblem } from '../content/validate'
import type { Message, MessageTree } from '../runtime/i18n'
import { existsSync } from 'node:fs'
import { relative } from 'node:path'
import process from 'node:process'
import { PROBLEMS_MARKER } from '../content/server'
import { flattenMessages, isPlural } from '../runtime/i18n'
import { buildingWithoutEnv } from '../server/env'
import { extensionMessageFiles, messagesFile } from '../server/i18n'

const PLACEHOLDER = /\{(\w+)\}/g
const SPECIAL = /[.*+?^${}()|[\]\\]/g

// A message as a locale reads it, with the catalog it comes from: the app's, or an extension's the app does not translate.
interface Entry {
  message: Message
  file: string
  source: string
}

// What each locale's messages get wrong against the default locale's: a key one lacks or has alone, a placeholder it drops or invents, a plural where the default has text.
// A locale's messages are the app's laid over its extensions', as the server reads them.
export async function messageProblems(root: string, config: I18nConfig, extensions: KayExtension[] = []): Promise<ContentProblem[]> {
  const problems: ContentProblem[] = []
  const read = new Map<string, { file: string, entries: Map<string, Entry> }>()

  for (const locale of config.locales) {
    const path = messagesFile(root, config, locale)
    const file = relative(root, path)
    const libraries = extensionMessageFiles(root, extensions, locale).filter(existsSync)
    const own = existsSync(path)

    // An extension's catalog stands in for an app with no text of its own in that locale.
    if (!own && libraries.length === 0) {
      problems.push({ file, line: 1, message: `is missing: i18n lists ${locale}, so its messages go here, export default defineMessages({ ... })` })

      continue
    }

    const tree = own ? (await import(path) as { default?: unknown }).default : {}

    if (typeof tree !== 'object' || tree === null) {
      problems.push({ file, line: 1, message: 'must export its messages by default: export default defineMessages({ ... })' })

      continue
    }

    const source = own ? await Bun.file(path).text() : ''
    const messages = flattenMessages(tree as MessageTree)

    for (const key of messages.keys()) {
      if (key.split('.').includes(''))
        problems.push({ file, line: lineOf(source, key), message: `names a message ${key}, with an empty part; a key may not hold a dot` })
    }

    const entries = new Map<string, Entry>()

    for (const catalog of libraries) {
      const libraryTree = (await import(catalog) as { default?: unknown }).default
      const librarySource = await Bun.file(catalog).text()

      if (typeof libraryTree === 'object' && libraryTree !== null) {
        for (const [key, message] of flattenMessages(libraryTree as MessageTree))
          entries.set(key, { message, file: relative(root, catalog), source: librarySource })
      }
    }

    for (const [key, message] of messages)
      entries.set(key, { message, file, source })

    read.set(locale, { file, entries })
  }

  const reference = read.get(config.defaultLocale)

  if (!reference)
    return problems

  for (const [locale, { file, entries }] of read) {
    if (locale === config.defaultLocale)
      continue

    for (const [key, { message, file: from }] of reference.entries) {
      const own = entries.get(key)

      if (own === undefined) {
        problems.push({ file, line: 1, message: `lacks ${key}, which ${from} has` })

        continue
      }

      const line = lineOf(own.source, key)

      if (isPlural(message) !== isPlural(own.message)) {
        problems.push({ file: own.file, line, message: `gives ${key} as ${isPlural(own.message) ? 'plural forms' : 'text'}, where ${from} gives ${isPlural(message) ? 'plural forms' : 'text'}` })

        continue
      }

      const expected = placeholders(message)
      const found = placeholders(own.message)

      for (const name of expected) {
        if (!found.has(name))
          problems.push({ file: own.file, line, message: `gives ${key} without {${name}}, which ${from} has` })
      }

      for (const name of found) {
        if (!expected.has(name))
          problems.push({ file: own.file, line, message: `gives ${key} a {${name}}, which ${from} has not, so nothing fills it` })
      }
    }

    for (const [key, own] of entries) {
      if (!reference.entries.has(key))
        problems.push({ file: own.file, line: lineOf(own.source, key), message: `has ${key}, which ${reference.file} lacks, so no \`t()\` can name it` })
    }
  }

  return problems
}

// Every placeholder of a message, a plural's forms together, its `count` included.
function placeholders(message: Message): Set<string> {
  const texts = typeof message === 'string' ? [message] : Object.values(message)
  const names = new Set(texts.flatMap(text => Array.from(text.matchAll(PLACEHOLDER), match => match[1]!)))

  if (typeof message !== 'string')
    names.add('count')

  return names
}

// The line a dotted key is written on, each part found after the one before it; the file's first line when the source spells it in a way this cannot follow.
function lineOf(source: string, key: string): number {
  let at = 0

  for (const part of key.split('.')) {
    const found = new RegExp(`(?:^|[\\s{,])['"]?${part.replace(SPECIAL, '\\$&')}['"]?\\s*:`, 'm').exec(source.slice(at))

    if (!found)
      return 1

    at += found.index + found[0].length
  }

  return source.slice(0, at).split('\n').length
}

// Run by `kay check` in a process of its own, so a message file edited since is read afresh: prints the problems as JSON on a marked line.
if (import.meta.main) {
  const [root, config, extensions] = process.argv.slice(2)

  // The checking machine lacks the server's environment, as `kay build` does.
  buildingWithoutEnv()
  console.log(`${PROBLEMS_MARKER}${JSON.stringify(await messageProblems(root!, JSON.parse(config!) as I18nConfig, JSON.parse(extensions ?? '[]') as KayExtension[]))}`)
}
