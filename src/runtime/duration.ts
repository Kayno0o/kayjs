// A length of time: seconds as a number, or a number with its unit, `'250ms'`, `'30s'`, `'5m'`, `'12h'`, `'30d'` or `'2w'`.
export type Duration = number | DurationText

// A duration written with its unit, never a bare number: for an option with no number to stay compatible with.
export type DurationText = `${number}${'ms' | keyof typeof UNIT_SECONDS}`

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 }

export const DURATION_TEXT = /^(\d+(?:\.\d+)?)(ms|[smhdw])$/

function inSeconds(amount: number, unit: string): number {
  return unit === 'ms' ? amount / 1000 : amount * UNIT_SECONDS[unit as keyof typeof UNIT_SECONDS]
}

// The seconds a positive duration stands for; `what` names the option in the error anything else throws, and `owner` the package whose option it is.
export function durationSeconds(value: unknown, what: string, owner = 'kay'): number {
  const text = typeof value === 'string' ? DURATION_TEXT.exec(value) : null
  const parsed = text ? inSeconds(Number(text[1]), text[2]!) : Number.NaN
  const seconds = typeof value === 'number' ? value : parsed

  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error(`${owner}: ${what} is ${typeof value === 'string' ? `'${value}'` : String(value)}; it takes a positive duration, seconds or a string such as '5m', '12h' or '30d'`)

  return seconds
}

// The same rounded up to whole seconds, for a header or a cookie that takes an integer: `'250ms'` is 1, never `0.25` nor 0.
export function wholeSeconds(value: unknown, what: string, owner = 'kay'): number {
  return Math.ceil(durationSeconds(value, what, owner))
}

// The milliseconds an option that took them before 1.52 stands for: a bare number is still milliseconds there, for three minors, and a string is a duration.
// No check on the value, as a timer takes whatever it gets; it only reads the text.
export function durationMs(value: number | string): number {
  if (typeof value === 'number')
    return value

  const text = DURATION_TEXT.exec(value)

  return text ? Math.round(text[2] === 'ms' ? Number(text[1]) : inSeconds(Number(text[1]), text[2]!) * 1000) : Number.NaN
}

// The same for a server or library option: a bare number is milliseconds as before, a string must be a positive duration or it throws naming the option.
export function optionMs(value: number | string, what: string, owner = 'kay'): number {
  if (typeof value === 'number')
    return value

  durationSeconds(value, what, owner)

  return durationMs(value)
}
