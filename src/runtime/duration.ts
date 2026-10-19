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

// The milliseconds a duration written with its unit stands for, `'250ms'` or `'3s'`; a bare number throws, as it would read as seconds elsewhere and as milliseconds here before 1.56.
// No check on the text, as a timer takes whatever it gets; a text that is no duration is NaN.
export function durationMs(value: DurationText): number {
  if (typeof value !== 'string')
    throw new Error(`kay: a duration here takes its unit, such as '3s' or '250ms', not ${String(value)}`)

  const text = DURATION_TEXT.exec(value)

  return text ? Math.round(text[2] === 'ms' ? Number(text[1]) : inSeconds(Number(text[1]), text[2]!) * 1000) : Number.NaN
}

// The same for a server or library option: a bare number throws naming the option, and a string must be a positive duration or it throws too.
export function optionMs(value: DurationText, what: string, owner = 'kay'): number {
  if (typeof value !== 'string')
    throw new Error(`${owner}: ${what} is ${String(value)}; it takes a duration with its unit, such as '3s' or '250ms'`)

  durationSeconds(value, what, owner)

  return durationMs(value)
}
