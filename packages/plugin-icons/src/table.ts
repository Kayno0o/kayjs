// words.json maps a word to its related icon-name words as `word percent word percent`, built by build/table.ts; read on the first search, as it weighs about 2 MB.
let table: Record<string, string> | undefined
const decoded = new Map<string, [string, number][]>()
const PERCENT = 100

function load(): Record<string, string> {
  // A synchronous lazy load keeps findIcons synchronous.
  table ??= require('./words.json') as Record<string, string>

  return table
}

// Swaps the table for one built in memory, as the bench scores tables learned without the set they are tested on.
export function replaceTable(next: Record<string, string>): void {
  table = next
  decoded.clear()
}

// The words the table knows, each a word a search may be typed with.
export function tableWords(): string[] {
  return Object.keys(load())
}

// The icon-name words related to `word`, each with its strength from 0 to 1, the strongest first.
export function relatedWords(word: string): [string, number][] {
  const known = decoded.get(word)

  if (known)
    return known

  const line = Object.hasOwn(load(), word) ? load()[word]! : ''
  const parts = line === '' ? [] : line.split(' ')
  const related: [string, number][] = []

  for (let i = 0; i + 1 < parts.length; i += 2)
    related.push([parts[i]!, Number(parts[i + 1]) / PERCENT])

  decoded.set(word, related)

  return related
}
