import type { Locale, LocaleSettings, Localize, MessageValue, Translate, Translations } from './i18n'
import { AsyncLocalStorage } from 'node:async_hooks'
import { formatDate as formatDateIn, formatNumber as formatNumberIn, localePath, translate } from './i18n'
import { insideIsland, noteMessage } from './island.server'

export type { Locale, LocaleSettings, Message, MessageKey, MessageTree, MessageValue, Plural, PluralCategory } from './i18n'
export { defineMessages } from './i18n'

// The locale a request is served in, for everything that runs while it is: loads, templates, components, actions and guards.
export interface LocaleState extends Translations {
  settings: LocaleSettings
  // The page's path without its locale prefix, for `alternate`.
  path: string
  host?: string
}

const store = new AsyncLocalStorage<LocaleState>()

export function runInLocale<T>(state: LocaleState, run: () => T): T {
  return store.run(state, run)
}

export function localeState(): LocaleState | undefined {
  return store.getStore()
}

function current(name: string): LocaleState {
  const state = store.getStore()

  if (!state)
    throw new Error(`kay: ${name} reads the request's locale, so it runs while a page, an action or a guard does, and needs \`i18n\` in kay.config.ts`)

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
  return current('locale()').locale as Locale
}

// A path of the site in the request's locale, or in the one given: `localize('/about')` is `/en/about` on an English page.
export const localize = ((href: string, target?: string) => {
  const state = current('localize()')

  return localePath(state.settings, href, target ?? state.locale, state.host)
}) as Localize

// The page being rendered in another locale, for a language switcher.
export function alternate(target: Locale): string {
  const state = current('alternate()')

  return localePath(state.settings, state.path, target, state.host)
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return formatNumberIn(current('formatNumber()').locale, value, options)
}

export function formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return formatDateIn(current('formatDate()').locale, value, options)
}
