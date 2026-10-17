const DAY = 86_400
const UNITS = [['hour', 3600], ['minute', 60], ['second', 1]] as const

// A lifetime in seconds as words in a language, in the largest unit it fills exactly, days from two on: `24 hours`, `7 days`, `1 heure`. A bad `locale` falls back to English.
export function durationWords(seconds: number, locale: string): string {
  const [unit, size] = seconds >= 2 * DAY && seconds % DAY === 0 ? ['day', DAY] as const : UNITS.find(([, size]) => seconds % size === 0) ?? UNITS[2]

  try {
    return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(seconds / size)
  }
  catch {
    return new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay: 'long' }).format(seconds / size)
  }
}
