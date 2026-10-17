// A length of time: seconds as a number, or a number with its unit, `'250ms'`, `'30s'`, `'5m'`, `'12h'`, `'30d'` or `'2w'`.
export type Duration = number | `${number}${DurationUnit}`

type DurationUnit = keyof typeof UNIT_MS

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

export const DURATION_TEXT = /^(\d+(?:\.\d+)?)(ms|[smhdw])$/

// The seconds a positive duration stands for; `what` names the option in the error anything else throws, and `owner` the package whose option it is.
export function durationSeconds(value: unknown, what: string, owner = 'kay'): number {
  const text = typeof value === 'string' ? DURATION_TEXT.exec(value) : null
  const parsed = text ? Number(text[1]) * UNIT_MS[text[2] as DurationUnit] / 1000 : Number.NaN
  const seconds = typeof value === 'number' ? value : parsed

  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error(`${owner}: ${what} is ${typeof value === 'string' ? `'${value}'` : String(value)}; it takes a positive duration, seconds or a string such as '5m', '12h' or '30d'`)

  return seconds
}

// The milliseconds an option that took them before 1.52 stands for: a bare number is still milliseconds there, for three minors, and a string is a duration.
// No check on the value, as a timer takes whatever it gets; it only reads the text.
export function durationMs(value: number | string): number {
  if (typeof value === 'number')
    return value

  const text = DURATION_TEXT.exec(value)

  return text ? Number(text[1]) * UNIT_MS[text[2] as DurationUnit] : Number.NaN
}

// The same for a server or library option: a bare number is milliseconds as before, a string must be a positive duration or it throws naming the option.
export function optionMs(value: number | string, what: string, owner = 'kay'): number {
  return typeof value === 'number' ? value : durationSeconds(value, what, owner) * 1000
}
