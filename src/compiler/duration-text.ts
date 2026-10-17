import { DURATION_TEXT } from '../runtime/duration'

// The duration string a positive number of milliseconds is written as, in seconds when it is a whole number of them; undefined for zero, a negative, an exponent or a fraction too small to say.
export function millisecondsText(milliseconds: number): string | undefined {
  if (!(milliseconds > 0))
    return undefined

  const text = milliseconds % 1000 === 0 ? `${milliseconds / 1000}s` : `${milliseconds}ms`

  return DURATION_TEXT.test(text) ? text : undefined
}
