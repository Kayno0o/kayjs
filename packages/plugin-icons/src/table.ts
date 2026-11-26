// words.json relates a word to icon-name words, built by build/table.ts and read on the first search: `lines` maps a word to `index percent index percent`, each index in base 36 into the words of `targets`.
import { byStem, stem } from './name-words'
import { completions, respellings } from './spelling'

export interface PackedTable {
  targets: string
  lines: Record<string, string>
}

let table: PackedTable | undefined
let replaced: Record<string, string> | undefined
let targets: string[] | undefined
let words: string[] | undefined
let stems: Map<string, string> | undefined
const decoded = new Map<string, [string, number][]>()
// The readings of typed words, shared by every set searched; typed words are unbounded, so only the latest are kept.
const completed = new Map<string, string[]>()
const respelled = new Map<string, [string, number][]>()
const REMEMBERED = 1000
const PERCENT = 100
const BASE = 36

function load(): PackedTable {
  // A synchronous lazy load keeps findIcons synchronous.
  table ??= replaced ? packTable(replaced) : require('./words.json') as PackedTable

  return table
}

// Packs `word: 'related percent related percent'` lines into the shape words.json holds.
export function packTable(plain: Record<string, string>): PackedTable {
  const all: string[] = []
  const at = new Map<string, number>()
  const lines: Record<string, string> = {}

  for (const [word, line] of Object.entries(plain)) {
    const parts = line === '' ? [] : line.split(' ')

    for (let i = 0; i < parts.length; i += 2) {
      if (!at.has(parts[i]!))
        at.set(parts[i]!, all.push(parts[i]!) - 1)
      parts[i] = at.get(parts[i]!)!.toString(BASE)
    }
    lines[word] = parts.join(' ')
  }

  return { targets: all.join(' '), lines }
}

// Swaps the table for one built in memory, as the bench scores tables learned without the set they are tested on.
export function replaceTable(next: Record<string, string>): void {
  replaced = next
  table = undefined
  targets = undefined
  words = undefined
  stems = undefined
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
  words ??= Object.keys(load().lines)

  return words
}

// The table's form of `word` when the table knows another, as `search` for `searching`.
export function tableForm(word: string): string | undefined {
  stems ??= byStem(tableWords())

  return stems.get(stem(word))
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

  const { lines } = load()
  const line = Object.hasOwn(lines, word) ? lines[word]! : ''
  const parts = line === '' ? [] : line.split(' ')
  const related: [string, number][] = []

  targets ??= load().targets.split(' ')
  for (let i = 0; i + 1 < parts.length; i += 2)
    related.push([targets[Number.parseInt(parts[i]!, BASE)]!, Number(parts[i + 1]) / PERCENT])

  decoded.set(word, related)

  return related
}
