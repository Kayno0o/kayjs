import { pageLocale } from 'kay/words'

const ENGLISH = /^en(?:-|$)/

// The page's locale for the dates a chart draws, every `en` keeping the day-first English (`5 Jan`) it always drew.
function dateLocale(): string {
  const page = pageLocale()

  return ENGLISH.test(page) ? 'en-GB' : page
}

// `5 Jan` in the page's locale.
export function dayMonth(date: Date): string {
  return date.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
}

// `Jan` in the page's locale.
export function monthShort(date: Date): string {
  return date.toLocaleDateString(dateLocale(), { month: 'short' })
}
