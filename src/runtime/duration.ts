// A length of time: seconds as a number, or a number with its unit, `'30s'`, `'5m'`, `'12h'`, `'30d'` or `'2w'`.
export type Duration = number | `${number}${DurationUnit}`

type DurationUnit = keyof typeof UNIT_SECONDS

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 }

export const DURATION_TEXT = /^(\d+(?:\.\d+)?)([smhdw])$/

// The seconds a positive duration stands for; `what` names the option in the error anything else throws, and `owner` the package whose option it is.
export function durationSeconds(value: unknown, what: string, owner = 'kay'): number {
  const text = typeof value === 'string' ? DURATION_TEXT.exec(value) : null
  const seconds = typeof value === 'number' ? value : text ? Number(text[1]) * UNIT_SECONDS[text[2] as DurationUnit] : Number.NaN

  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error(`${owner}: ${what} is ${typeof value === 'string' ? `'${value}'` : String(value)}; it takes a positive duration, seconds or a string such as '5m', '12h' or '30d'`)

  return seconds
}
