import type { MessageValue, Plural } from './i18n'
import { sizeText as sizeIn } from './size-text'

// What the server writes for a page's islands and checked forms: the locale and the messages they use. Kept small, as every island of a library reaches it, and free of `pageData`, which a lazy chunk reading it would keep in the eager entry; `kay/i18n` reads the same scripts for `t`.
interface Payload {
  locale?: string
  messages: Record<string, string | Plural>
}

const PAYLOAD = 'script[data-kay-i18n]'
const PLACEHOLDER = /\{(\w+)\}/g
const read = new WeakSet<Element>()
const messages = new Map<string, string | Plural>()
let locale = ''
// Whether the page was searched for scripts since the last microtask: a render looks up many texts, and one search serves them all.
let searched = false

function parse(text: string): Payload | undefined {
  try {
    return JSON.parse(text) as Payload
  }
  catch {
    return undefined
  }
}

function load(): void {
  if (searched)
    return

  searched = true
  queueMicrotask(() => {
    searched = false
  })

  for (const script of document.querySelectorAll(PAYLOAD)) {
    if (read.has(script))
      continue

    const payload = parse(script.textContent ?? '')

    // A script still streaming does not parse yet: it is read again with the next lookup.
    if (!payload)
      continue

    read.add(script)
    locale ||= payload.locale ?? ''

    for (const [key, message] of Object.entries(payload.messages))
      messages.set(key, message)
  }
}

// The English as written, a number as `String` has it, so a site without the key reads what it always did; a date is written as the page's locale writes it.
function plainEnglish(english: string, params: Record<string, MessageValue>): string {
  return english.replace(PLACEHOLDER, (placeholder, name: string) => {
    if (!(name in params))
      return placeholder

    const value = params[name]!

    return value instanceof Date ? new Intl.DateTimeFormat(pageLocale(), { dateStyle: 'medium' }).format(value) : String(value)
  })
}

// The page's locale, from the messages the server wrote or else its `lang`.
export function pageLocale(): string {
  if (locale === '')
    load()

  return locale || document.documentElement.lang || 'en'
}

// The message at `key` when the page brought it, else `english`; see the server's.
export function wording(key: string, english: string, params: Record<string, MessageValue> = {}): string {
  if (!messages.has(key))
    load()

  const found = messages.get(key)

  if (found === undefined)
    return plainEnglish(english, params)

  const here = pageLocale()
  let text = typeof found === 'string' ? found : found.other

  if (typeof found !== 'string' && typeof params.count === 'number')
    text = (params.count === 0 ? found.zero : undefined) ?? found[new Intl.PluralRules(here).select(params.count)] ?? found.other

  return text.replace(PLACEHOLDER, (placeholder, name: string) => {
    const value = params[name]

    if (value === undefined)
      return placeholder

    if (value instanceof Date)
      return new Intl.DateTimeFormat(here, { dateStyle: 'medium' }).format(value)

    return typeof value === 'number' ? new Intl.NumberFormat(here).format(value) : String(value)
  })
}

// `1 MB`, `512 KB`, `200 bytes` as the page's locale writes a size (`1 Mo`, `200 octets`), for a text that names a file's weight or a limit.
export function sizeText(bytes: number, locale = pageLocale()): string {
  return sizeIn(bytes, locale)
}
