import type { Direction, Locale, LocaleSettings, Localize, Message, MessageValue, RelativeTimeOptions, Translate } from './i18n'
import { withBase, withoutBase } from './base'
import { formatDate as formatDateIn, formatList as formatListIn, formatNumber as formatNumberIn, formatRelativeTime as formatRelativeTimeIn, localePath, splitLocale, textDirection, translate } from './i18n'

export type { Direction, Locale, LocaleSettings, Message, MessageKey, MessageTree, MessageValue, Plural, PluralCategory, RelativeTimeOptions } from './i18n'
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
  // eslint-disable-next-line ts/no-unnecessary-type-assertion -- Locale is a string in kay itself and an app's own locales once its Register names them
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

export function formatRelativeTime(value: Date | number, options?: RelativeTimeOptions): string
export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string
export function formatRelativeTime(value: Date | number, unitOrOptions?: Intl.RelativeTimeFormatUnit | RelativeTimeOptions, options?: Intl.RelativeTimeFormatOptions): string {
  return formatRelativeTimeIn(translations().locale, value, unitOrOptions, options)
}

export function formatList(items: Iterable<string>, options?: Intl.ListFormatOptions): string {
  return formatListIn(translations().locale, items, options)
}

// Which way a locale's script runs, the request's or any one given, for what lays itself out by hand: `rtl` or `ltr`.
export function direction(of?: string): Direction {
  return textDirection(of ?? translations().locale)
}
