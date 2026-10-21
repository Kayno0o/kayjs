import type { Direction, Locale, Localize, MessageValue, RelativeTimeOptions, RichText, Translate } from './i18n'
import type { JSX } from './jsx'
import type { LocaleState } from './locale-state'
import { formatDate as formatDateIn, formatList as formatListIn, formatNumber as formatNumberIn, formatRelativeTime as formatRelativeTimeIn, leadsWithLocale, localeName as localeNameIn, localePath, richMessage, textDirection, translate } from './i18n'
import { insideIsland, noteMessage } from './island.server'
import { localeState } from './locale-state'
import { PART_END, PART_START } from './markers'
import { html } from './rendered'

export type { Direction, Locale, LocaleSettings, MergeMessages, Message, MessageKey, MessageTree, MessageValue, Plural, PluralCategory, RelativeTimeOptions, RichText } from './i18n'
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

// The message at `key` with each of its tags rendered through the block of that name: `T(key="intro")` with `@about(text)` for `<about>our story</about>`.
export const T = ((props: { key: string }) => {
  const state = current('T')

  if (!insideIsland())
    return richMessage(state, props.key, props) as JSX.Element

  noteMessage(props.key)

  // The markers the browser's T fills again between, when a placeholder changes.
  return [html(`<!--${PART_START}-->`), richMessage(state, props.key, props), html(`<!--${PART_END}-->`)] as JSX.Element
}) as RichText

export function locale(): Locale {
  // eslint-disable-next-line ts/no-unnecessary-type-assertion -- Locale is a string in kay itself and an app's own locales once its Register names them
  return current('locale()').locale as Locale
}

// A path of the site in the request's locale, or in the one given: `localize('/about')` is `/en/about` on an English page.
export const localize = ((href: string, target?: string) => {
  const state = current('localize()')

  return state.implicit || leadsWithLocale(state.settings, href) ? href : localePath(state.settings, href, target ?? state.locale, state.host)
}) as Localize

// The page being rendered in another locale, for a language switcher.
export function alternate(target: Locale): string {
  const state = current('alternate()')

  return state.implicit ? state.path : localePath(state.settings, state.path, target, state.host)
}

// Every locale the site is served in, the default one first as `i18n` lists it, for a language switcher: `for code of locales()` with `alternate(code)` and `localeName(code)`.
export function locales(): Locale[] {
  return current('locales()').settings.locales as Locale[]
}

// A locale named in its own language, `Français` for `fr`, whichever locale the page is in.
export function localeName(target: Locale): string {
  return localeNameIn(target)
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

// A date relative to the page's render time, formatted as `formatRelativeTime` does; in the browser it goes on ticking, see the browser's.
export function relativeTime(value: () => Date | number, options?: Intl.RelativeTimeFormatOptions): () => string {
  const state = current('relativeTime()')

  state.now ??= Date.now()

  const { locale, now } = state

  return () => formatRelativeTimeIn(locale, value(), { ...options, now })
}

export function formatList(items: Iterable<string>, options?: Intl.ListFormatOptions): string {
  return formatListIn(current('formatList()').locale, items, options)
}

// Which way a locale's script runs, the request's or any one given, for what lays itself out by hand: `rtl` or `ltr`.
export function direction(of?: string): Direction {
  return textDirection(of ?? current('direction()').locale)
}
