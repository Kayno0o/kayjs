const SPLIT = /[^a-z0-9]+/
const DIGITS = /^\d+$/

// The words of an icon name or a query, `arrow-left-2` giving `arrow` and `left`.
export function nameWords(text: string): string[] {
  return text.toLowerCase().split(SPLIT).filter(word => word.length > 1 && !DIGITS.test(word))
}
