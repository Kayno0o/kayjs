import type { Locale, LocaleSettings, Localize, Message, MessageValue, Translate } from './i18n'
import { withBase, withoutBase } from './base'
import { formatDate as formatDateIn, formatNumber as formatNumberIn, localePath, splitLocale, translate } from './i18n'

export type { Locale, LocaleSettings, Message, MessageKey, MessageTree, MessageValue, Plural, PluralCategory } from './i18n'
export { defineMessages } from './i18n'

// What the server writes for a page's islands, one script per part of a streamed page: the locale, and the messages its islands use.
interface Payload {
  locale?: string
  settings?: LocaleSettings
  messages: Record<string, Message>
}

const PAYLOAD = 'script[data-kay-i18n]'
const read = new WeakSet<Element>()
const messages = new Map<string, Message>()
let settings: LocaleSettings | undefined
let pageLocale = ''

// Reads the scripts not read yet, so messages a streamed part brought are found too.
function load(): void {
  for (const script of document.querySelectorAll(PAYLOAD)) {
    if (read.has(script))
      continue

    read.add(script)

    const payload = JSON.parse(script.textContent ?? '{}') as Payload

    settings ??= payload.settings
    pageLocale ||= payload.locale ?? ''

    for (const [key, message] of Object.entries(payload.messages))
      messages.set(key, message)
  }
}

function translations() {
  load()

  return { locale: pageLocale || document.documentElement.lang, messages }
}

export const t = ((key: string, params?: Record<string, MessageValue>) => {
  if (!messages.has(key))
    load()

  return translate(translations(), key, params)
}) as Translate

export function locale(): Locale {
  return translations().locale as Locale
}

export const localize = ((href: string, target?: string) => {
  const { locale: current } = translations()

  return withBase(settings ? localePath(settings, href, target ?? current, location.host) : href)
}) as Localize

export function alternate(target: Locale): string {
  load()

  const path = withoutBase(location.pathname)

  return withBase(settings ? localePath(settings, splitLocale(settings, path).path, target, location.host) : path)
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return formatNumberIn(translations().locale, value, options)
}

export function formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return formatDateIn(translations().locale, value, options)
}
