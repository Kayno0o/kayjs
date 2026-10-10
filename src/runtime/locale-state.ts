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
}

const store = new AsyncLocalStorage<LocaleState>()

export function runInLocale<T>(state: LocaleState, run: () => T): T {
  return store.run(state, run)
}

export function localeState(): LocaleState | undefined {
  return store.getStore()
}
