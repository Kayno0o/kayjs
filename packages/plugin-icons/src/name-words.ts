const SPLIT = /[^a-z0-9]+/
const DIGITS = /^\d+$/

// The words of an icon name or a query, `arrow-left-2` giving `arrow` and `left`, and `circle-x` giving `circle` and `x`.
export function nameWords(text: string): string[] {
  return text.toLowerCase().split(SPLIT).filter(word => word !== '' && !DIGITS.test(word))
}

// How many parts a name has, numbers included, so `user-2` and `user-x` weigh as variants of `user`.
export function nameParts(name: string): number {
  return name.toLowerCase().split(SPLIT).filter(part => part !== '').length
}
