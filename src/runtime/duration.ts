// A length of time written with its unit, never a bare number: `'250ms'`, `'30s'`, `'5m'`, `'12h'`, `'30d'` or `'2w'`.
export type Duration = `${number}${'ms' | keyof typeof UNIT_SECONDS}`

// The name `Duration` replaced in 1.70, which took the string alone.
/** @deprecated Use `Duration`. */
export type DurationText = Duration

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 }

export const DURATION_TEXT = /^(\d+(?:\.\d+)?)(ms|[smhdw])$/

const ZERO_DURATION = /^0(?:\.0+)?(?:ms|[smhdw])$/

// A zero, `'0s'`, which the options that take one read as "none"; the bare 0 is the form before 1.70.
export function isZeroDuration(value: unknown): boolean {
  return value === 0 || (typeof value === 'string' && ZERO_DURATION.test(value))
}

function inSeconds(amount: number, unit: string): number {
  return unit === 'ms' ? amount / 1000 : amount * UNIT_SECONDS[unit as keyof typeof UNIT_SECONDS]
}

// The seconds a positive duration stands for; `what` names the option in the error anything else throws.
// A bare number still reads as seconds until 1.73, the form `deprecated-bare-duration` rewrites; the type refuses it.
export function durationSeconds(value: unknown, what: string): number {
  const text = typeof value === 'string' ? DURATION_TEXT.exec(value) : null
  const parsed = text ? inSeconds(Number(text[1]), text[2]!) : Number.NaN
  const seconds = typeof value === 'number' ? value : parsed

  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error(`kay: ${what} is ${typeof value === 'string' ? `'${value}'` : String(value)}; it takes a positive duration such as '250ms', '5m' or '30d'`)

  return seconds
}

// The same rounded up to whole seconds, for a header or a cookie that takes an integer: `'250ms'` is 1, never `0.25` nor 0.
export function wholeSeconds(value: unknown, what: string): number {
  return Math.ceil(durationSeconds(value, what))
}

// The milliseconds a duration stands for, `'250ms'` or `'3s'`, for a timer of your own; a bare number throws.
// No check on the text, as a timer takes whatever it gets; a text that is no duration is NaN.
export function durationMs(value: Duration): number {
  if (typeof value !== 'string')
    throw new Error(`kay: a duration here takes its unit, such as '3s' or '250ms', not ${String(value)}`)

  const text = DURATION_TEXT.exec(value)

  return text ? Math.round(text[2] === 'ms' ? Number(text[1]) : inSeconds(Number(text[1]), text[2]!) * 1000) : Number.NaN
}

// The same for a server or library option: a bare number throws naming the option, and a string must be a positive duration or it throws too.
export function optionMs(value: Duration, what: string): number {
  if (typeof value !== 'string')
    throw new Error(`kay: ${what} is ${String(value)}; it takes a duration with its unit, such as '3s' or '250ms'`)

  durationSeconds(value, what)

  return durationMs(value)
}

// The milliseconds of an option that took a number of them before 1.70, which still reads so until 1.73 though its type no longer allows it.
export function legacyMs(value: Duration | number, what: string): number {
  return typeof value === 'number' ? value : optionMs(value, what)
}
