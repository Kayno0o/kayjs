import type { DateFormatOptions, MessageValue, NumberFormatOptions } from './i18n'
import { formatDate as formatDateIn, formatNumber as formatNumberIn, lookup } from './i18n'
import { insideIsland, noteMessage } from './island.server'
import { localeState } from './locale-state'
import { sizeText as sizeIn } from './size-text'

const PLACEHOLDER = /\{(\w+)\}/g

// The English as written, a number as `String` has it, so a site without the key reads what it always did; a date is written as the page's locale writes it.
function plainEnglish(english: string, params: Record<string, MessageValue>): string {
  return english.replace(PLACEHOLDER, (placeholder, name: string) => {
    if (!(name in params))
      return placeholder

    const value = params[name]!

    return value instanceof Date ? formatDateIn(localeState()?.locale ?? 'en', value) : String(value)
  })
}

// The message at `key` when the app's catalogs have it, else `english`, placeholders filled either way: the lookup kay and its libraries word what a visitor reads through, so a site gives `kay.*` or `ui.*` messages only for the texts it translates. Needs no request: outside one it is the English. An island's use of it sends the message to the browser, once its source names the key as a literal. Values are strings and numbers.
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

// A date as the page's locale writes it, in the site's `timeZone`; `kay/i18n`'s `formatDate` too, which the browser's entry of this module does without the rest of that one.
export function formatDate(value: Date | number, options?: DateFormatOptions): string {
  return formatDateIn(pageLocale(), value, options)
}

// A number as the page's locale writes it; `kay/i18n`'s `formatNumber` too.
export function formatNumber(value: number, options?: NumberFormatOptions): string {
  return formatNumberIn(pageLocale(), value, options)
}

// `1 MB`, `512 KB`, `200 bytes` as the page's locale writes a size (`1 Mo`, `200 octets`), for a text that names a file's weight or a limit.
export function sizeText(bytes: number, locale = pageLocale()): string {
  return sizeIn(bytes, locale)
}
