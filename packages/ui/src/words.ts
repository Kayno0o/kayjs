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

// `16:12` in the page's locale, with seconds when asked.
export function timeOfDay(date: Date, seconds: boolean): string {
  return date.toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', ...seconds ? { second: '2-digit' } : {} })
}

// `21 Oct 2026` in the page's locale, followed by the time of day when asked.
export function fullDate(date: Date, time: false | 'minutes' | 'seconds'): string {
  const day = date.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' })

  if (time === false)
    return day

  // The server cannot know the viewer's timezone, so what it renders names its own until the island writes the viewer's local time.
  const zone = typeof window === 'undefined' ? ` ${date.toLocaleTimeString(dateLocale(), { timeZoneName: 'short' }).split(' ').at(-1)}` : ''

  return `${day}, ${timeOfDay(date, time === 'seconds')}${zone}`
}
