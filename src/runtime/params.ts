// The param matchers kay ships, which a `[name=matcher]` segment names: each gives the param's value, or undefined to refuse the URL.

const INTEGER = /^-?\d+$/
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const WORD = String.raw`[\p{Ll}\p{Lo}\p{Lm}\p{M}\p{N}_]+`
const SLUG = new RegExp(`^${WORD}(?:[-/]${WORD})*$`, 'u')

// A whole number within the safe range, as a number.
export function integer(value: string): number | undefined {
  const number = Number(value)

  return INTEGER.test(value) && Number.isSafeInteger(number) ? number : undefined
}

// A UUID in any case, lowercased.
export function uuid(value: string): string | undefined {
  return UUID.test(value) ? value.toLowerCase() : undefined
}

// Lowercase words of any script joined by single dashes, or slashes for a rest param: what the cms `slugify` gives.
export function slug(value: string): string | undefined {
  return SLUG.test(value) ? value : undefined
}
