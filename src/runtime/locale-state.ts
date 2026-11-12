import type { LocaleSettings, Translations } from './i18n'
import { AsyncLocalStorage } from 'node:async_hooks'

// The locale a request is served in, for everything that runs while it is: loads, templates, components, actions and guards.
export interface LocaleState extends Translations {
  settings: LocaleSettings
  // The page's path without its locale prefix, untranslated, for `alternate`.
  path: string
  host?: string
  // A site without `i18n`, its one language's messages read and its URLs carrying no locale.
  implicit?: true
  // The moment `relativeTime` reads the page as rendered at, taken on its first call and written into the page once, so the islands' first render in the browser reads the same.
  now?: number
  nowWritten?: true
  // The url of a routed entry the page read in each locale having it, by the url shown, which `alternate` gives for another locale instead of the same slug.
  entryUrls?: Map<string, Record<string, string>>
}

const store = new AsyncLocalStorage<LocaleState>()

export function runInLocale<T>(state: LocaleState, run: () => T): T {
  return store.run(state, run)
}

// The url of the entry the page shows in each locale having it, which `alternate` gives for another locale instead of the same slug.
export function shownEntryUrls(state: LocaleState): Record<string, string> | undefined {
  return state.entryUrls?.get(shownPath(state.path))
}

// A page's path as `entryUrls` keys it, without a trailing slash.
export function shownPath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

export function localeState(): LocaleState | undefined {
  return store.getStore()
}

let siteLocale = 'en'
let siteLocaleList: readonly string[] | undefined

// The site's default locale, installed once its locales are known, which the formatters use where no request runs, as a job or an alert does; `all` is every locale it is served in, the default first.
export function setSiteLocale(locale: string, all?: readonly string[]): void {
  siteLocale = locale
  siteLocaleList = all
}

// Every locale the site is served in, the default first: only the default one where the site names no others, or before the server has set up.
export function siteLocales(): readonly string[] {
  return siteLocaleList ?? [siteLocale]
}

export function siteDefaultLocale(): string {
  return siteLocale
}
