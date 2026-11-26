// words.json maps a word to its related icon-name words as `word percent word percent`, built by build/table.ts; read on the first search, as it weighs about 2 MB.
import { completions, respellings } from './spelling'

let table: Record<string, string> | undefined
let words: string[] | undefined
const decoded = new Map<string, [string, number][]>()
// The readings of typed words, shared by every set searched; typed words are unbounded, so only the latest are kept.
const completed = new Map<string, string[]>()
const respelled = new Map<string, [string, number][]>()
const REMEMBERED = 1000
const PERCENT = 100

function load(): Record<string, string> {
  // A synchronous lazy load keeps findIcons synchronous.
  table ??= require('./words.json') as Record<string, string>

  return table
}

// Swaps the table for one built in memory, as the bench scores tables learned without the set they are tested on.
export function replaceTable(next: Record<string, string>): void {
  table = next
  words = undefined
  decoded.clear()
  completed.clear()
  respelled.clear()
}

function remember<T>(cache: Map<string, T>, word: string, read: () => T): T {
  let found = cache.get(word)

  if (found === undefined) {
    found = read()

    if (cache.size >= REMEMBERED)
      cache.delete(cache.keys().next().value!)
    cache.set(word, found)
  }

  return found
}

// The words the table knows, each a word a search may be typed with.
export function tableWords(): string[] {
  words ??= Object.keys(load())

  return words
}

// The table words starting with `word`, unsorted.
export function tableCompletions(word: string): string[] {
  return remember(completed, word, () => completions(word, tableWords()))
}

// The table words close to `word`, with their edits, unsorted.
export function tableRespellings(word: string): [string, number][] {
  return remember(respelled, word, () => respellings(word, tableWords()))
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
