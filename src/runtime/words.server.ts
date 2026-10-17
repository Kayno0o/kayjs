import type { MessageValue } from './i18n'
import { lookup } from './i18n'
import { insideIsland, noteMessage } from './island.server'
import { localeState } from './locale-state'

const PLACEHOLDER = /\{(\w+)\}/g

// The English as written, a number as `String` has it, so a site without the key reads what it always did.
function plainEnglish(english: string, params: Record<string, MessageValue>): string {
  return english.replace(PLACEHOLDER, (placeholder, name: string) => name in params ? String(params[name]) : placeholder)
}

// The message at `key` when the app's catalogs have it, else `english`, placeholders filled either way: the lookup kay and its libraries word what a visitor reads through, so a site gives `kay.*` or `ui.*` messages only for the texts it translates. Needs no request: outside one it is the English. An island's use of it sends the message to the browser.
export function wording(key: string, english: string, params: Record<string, MessageValue> = {}): string {
  const state = localeState()
  const found = state && lookup(state, key, params)

  if (found === undefined)
    return plainEnglish(english, params)

  if (insideIsland())
    noteMessage(key)

  return found
}

// The request's locale, `en` outside one: for the formats a library draws itself, such as a chart's dates.
export function pageLocale(): string {
  return localeState()?.locale ?? 'en'
}
