// The param matchers kay ships, which a `[name=matcher]` segment names: each gives the param's value, or undefined to refuse the URL.

const INTEGER = /^-?\d+$/
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const SLUG = /^[a-z\d]+(?:-[a-z\d]+)*$/

// A whole number within the safe range, as a number.
export function integer(value: string): number | undefined {
  const number = Number(value)

  return INTEGER.test(value) && Number.isSafeInteger(number) ? number : undefined
}

// A UUID in any case, lowercased.
export function uuid(value: string): string | undefined {
  return UUID.test(value) ? value.toLowerCase() : undefined
}

// Lowercase words joined by single dashes.
export function slug(value: string): string | undefined {
  return SLUG.test(value) ? value : undefined
}
