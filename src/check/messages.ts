import type { I18nConfig, KayExtension } from '../config'
import type { ContentProblem } from '../content/validate'
import type { Message, MessageTree } from '../runtime/i18n'
import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { KayError } from '../compiler/errors'
import { PROBLEMS_MARKER } from '../content/claims'
import { flattenMessages, isPlural, MESSAGE_TAG } from '../runtime/i18n'
import { buildingWithoutEnv } from '../server/env-state'
import { extensionMessageFiles, messagesFile } from '../server/i18n'
import { draftMessages } from '../server/message-drafts'
import { FILES_MARKER, loadedFiles } from './loaded'

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
    const catalog = await localeCatalog(root, config, extensions, locale)

    if ('problem' in catalog) {
      problems.push(catalog.problem)

      continue
    }

    const { file, source, own, entries } = catalog

    for (const key of own) {
      if (key.split('.').includes(''))
        problems.push({ file, line: lineOf(source, key), message: `names a message ${key}, with an empty part; a key may not hold a dot` })
    }

    for (const { key, line } of draftMessages(source))
      problems.push({ file, line, message: `gives ${key} as a draft, which no one has checked yet`, code: 'draft-message' })

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

      const tagged = tags(message)
      const ownTags = tags(own.message)

      for (const name of tagged) {
        if (!ownTags.has(name))
          problems.push({ file: own.file, line, message: `gives ${key} without <${name}>, which ${from} has, so its block renders nothing` })
      }

      for (const name of ownTags) {
        if (!tagged.has(name))
          problems.push({ file: own.file, line, message: `gives ${key} a <${name}>, which ${from} has not, so no block renders it` })
      }
    }

    for (const [key, own] of entries) {
      if (!reference.entries.has(key))
        problems.push({ file: own.file, line: lineOf(own.source, key), message: `has ${key}, which ${reference.file} lacks, so no \`t()\` can name it` })
    }
  }

  return problems
}

// The keys each locale but the default lacks, with the default locale's message for each; a locale with no catalog at all lacks every key, and a default locale without one fails, as nothing says what the others lack.
export async function missingMessages(root: string, config: I18nConfig, extensions: KayExtension[] = []): Promise<Map<string, Map<string, Message>>> {
  const reference = await localeCatalog(root, config, extensions, config.defaultLocale)
  const missing = new Map<string, Map<string, Message>>()

  if ('problem' in reference)
    throw new KayError('locales-invalid', `kay: ${reference.problem.file} ${reference.problem.message}`)

  for (const locale of config.locales) {
    if (locale === config.defaultLocale)
      continue

    const catalog = await localeCatalog(root, config, extensions, locale)
    const lacked = new Map<string, Message>()

    for (const [key, { message }] of reference.entries) {
      if ('problem' in catalog || !catalog.entries.has(key))
        lacked.set(key, message)
    }

    missing.set(locale, lacked)
  }

  return missing
}

// A locale's messages as the server reads them, the app's laid over its extensions', each with the catalog it comes from, and the keys of the app's own file; or why there are none to read.
async function localeCatalog(root: string, config: I18nConfig, extensions: KayExtension[], locale: string): Promise<{ file: string, source: string, own: string[], entries: Map<string, Entry> } | { problem: ContentProblem }> {
  const path = messagesFile(root, config, locale)
  const file = relative(root, path)
  const libraries = extensionMessageFiles(root, extensions, locale).filter(existsSync)
  const own = existsSync(path)

  // An extension's catalog stands in for an app with no text of its own in that locale.
  if (!own && libraries.length === 0)
    return { problem: { file, line: 1, message: `is missing: i18n lists ${locale}, so its messages go here, export default defineMessages({ ... })` } }

  const tree = own ? (await import(path) as { default?: unknown }).default : {}

  if (typeof tree !== 'object' || tree === null)
    return { problem: { file, line: 1, message: 'must export its messages by default: export default defineMessages({ ... })' } }

  const source = own ? await Bun.file(path).text() : ''
  const messages = flattenMessages(tree as MessageTree)
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

  return { file, source, own: [...messages.keys()], entries }
}

// Every placeholder of a message, a plural's forms together, its `count` included.
function placeholders(message: Message): Set<string> {
  const texts = typeof message === 'string' ? [message] : Object.values(message)
  const names = new Set(texts.flatMap(text => Array.from(text.matchAll(PLACEHOLDER), match => match[1]!)))

  if (typeof message !== 'string')
    names.add('count')

  return names
}

// Every tag of a message, a plural's forms together, as `T` reads them.
function tags(message: Message): Set<string> {
  const texts = typeof message === 'string' ? [message] : Object.values(message)

  return new Set(texts.flatMap(text => Array.from(text.matchAll(MESSAGE_TAG), match => match[1]!)))
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
  const i18n = JSON.parse(config!) as I18nConfig
  const catalogs = JSON.parse(extensions ?? '[]') as KayExtension[]

  console.log(`${PROBLEMS_MARKER}${JSON.stringify(await messageProblems(root!, i18n, catalogs))}`)
  console.log(`${FILES_MARKER}${JSON.stringify(loadedFiles(resolve(root!), i18n.locales.flatMap(locale => [messagesFile(root!, i18n, locale), ...extensionMessageFiles(root!, catalogs, locale)])))}`)
  // A timer or a connection a message file left open would keep the check waiting.
  process.exit(0)
}
