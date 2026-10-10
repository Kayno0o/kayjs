import type { Direction, Locale, Localize, MessageValue, RelativeTimeOptions, Translate } from './i18n'
import type { LocaleState } from './locale-state'
import { formatDate as formatDateIn, formatList as formatListIn, formatNumber as formatNumberIn, formatRelativeTime as formatRelativeTimeIn, localePath, textDirection, translate } from './i18n'
import { insideIsland, noteMessage } from './island.server'
import { localeState } from './locale-state'

export type { Direction, Locale, LocaleSettings, MergeMessages, Message, MessageKey, MessageTree, MessageValue, Plural, PluralCategory, RelativeTimeOptions } from './i18n'
export { defineMessages } from './i18n'

function current(name: string): LocaleState {
  const state = localeState()

  if (!state)
    throw new Error(`kay: ${name} reads the request's locale, so it runs while a page, an action or a guard does`)

  return state
}

// The message at `key` in the request's locale, its placeholders filled; an island's messages go to the browser with it.
export const t = ((key: string, params?: Record<string, MessageValue>) => {
  const state = current('t()')

  if (insideIsland())
    noteMessage(key)

  return translate(state, key, params)
}) as Translate

export function locale(): Locale {
  // eslint-disable-next-line ts/no-unnecessary-type-assertion -- Locale is a string in kay itself and an app's own locales once its Register names them
  return current('locale()').locale as Locale
}

// A path of the site in the request's locale, or in the one given: `localize('/about')` is `/en/about` on an English page.
export const localize = ((href: string, target?: string) => {
  const state = current('localize()')

  if (state.implicit)
    return href

  return localePath(state.settings, href, target ?? state.locale, state.host)
}) as Localize

// The page being rendered in another locale, for a language switcher.
export function alternate(target: Locale): string {
  const state = current('alternate()')

  if (state.implicit)
    return state.path

  return localePath(state.settings, state.path, target, state.host)
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return formatNumberIn(current('formatNumber()').locale, value, options)
}

export function formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return formatDateIn(current('formatDate()').locale, value, options)
}

export function formatRelativeTime(value: Date | number, options?: RelativeTimeOptions): string
export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string
export function formatRelativeTime(value: Date | number, unitOrOptions?: Intl.RelativeTimeFormatUnit | RelativeTimeOptions, options?: Intl.RelativeTimeFormatOptions): string {
  return formatRelativeTimeIn(current('formatRelativeTime()').locale, value, unitOrOptions, options)
}

export function formatList(items: Iterable<string>, options?: Intl.ListFormatOptions): string {
  return formatListIn(current('formatList()').locale, items, options)
}

// Which way a locale's script runs, the request's or any one given, for what lays itself out by hand: `rtl` or `ltr`.
export function direction(of?: string): Direction {
  return textDirection(of ?? current('direction()').locale)
}
