import type { MessageValue } from 'kay/i18n'
import { pageLocale, wording } from 'kay/words'

// A text a component shows by default: the message at `ui.<key>` in the app's catalogs, else its English; a prop given to the component replaces both.
export function word(key: string, english: string, params?: Record<string, MessageValue>): string {
  return wording(`ui.${key}`, english, params)
}

// The page's locale for the dates a chart draws, `en` keeping the day-first English (`5 Jan`) it always drew.
function dateLocale(): string {
  const page = pageLocale()

  return page === 'en' ? 'en-GB' : page
}

// `5 Jan` in the page's locale.
export function dayMonth(date: Date): string {
  return date.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
}

// `Jan` in the page's locale.
export function monthShort(date: Date): string {
  return date.toLocaleDateString(dateLocale(), { month: 'short' })
}
