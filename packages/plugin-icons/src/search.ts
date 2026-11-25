import { nameWords } from './name-words'
import { closeWords, completions } from './spelling'
import { relatedWords, tableWords } from './table'

// An iconify set as `@iconify-json/<prefix>/icons.json` holds it, of which only the names of its icons and aliases are read.
export interface IconifyNames {
  icons: Record<string, unknown>
  aliases?: Record<string, unknown> | undefined
}

export interface IconPage {
  limit?: number | undefined
  offset?: number | undefined
}

interface Index {
  names: readonly string[]
  byWord: Map<string, string[]>
  wordCount: Map<string, number>
  order: Map<string, number>
  // The words a typed word may be completed or respelled into: the names' own and the table's.
  vocabulary: string[]
}

const SPACES = /\s+/g
// A word typed as given counts twice what a related word, a completion or a respelling brings.
const OWN_WEIGHT = 2
const COMPLETION_WEIGHT = 0.7
const RESPELLING_WEIGHT = 0.8

// One index per names array or set object, so a set imported once is indexed once.
const indexes = new WeakMap<readonly string[] | IconifyNames, Index>()

function indexOf(source: readonly string[] | IconifyNames): Index {
  const known = indexes.get(source)

  if (known)
    return known

  const names = isNames(source) ? source : [...Object.keys(source.icons), ...Object.keys(source.aliases ?? {})]
  const byWord = new Map<string, string[]>()
  const wordCount = new Map<string, number>()

  for (const name of names) {
    const words = new Set(nameWords(name))

    wordCount.set(name, words.size)

    for (const word of words) {
      const list = byWord.get(word)

      if (list)
        list.push(name)
      else
        byWord.set(word, [name])
    }
  }

  const index = { names, byWord, wordCount, order: new Map(names.map((name, i) => [name, i])), vocabulary: [...new Set([...byWord.keys(), ...tableWords()])] }

  indexes.set(source, index)

  return index
}

function isNames(source: readonly string[] | IconifyNames): source is readonly string[] {
  return Array.isArray(source)
}

// What a typed word stands for: itself when the names or the table know it, else its completions and close spellings.
function readings(word: string, index: Index): [string, number][] {
  if (index.byWord.has(word) || relatedWords(word).length > 0)
    return [[word, 1]]

  const known = (candidate: string) => index.byWord.get(candidate)?.length ?? 0

  return [
    ...completions(word, index.vocabulary, known).map(found => [found, COMPLETION_WEIGHT] as [string, number]),
    ...closeWords(word, index.vocabulary).map(found => [found, RESPELLING_WEIGHT] as [string, number]),
  ]
}

function literalRank(name: string, literal: string): number {
  if (name === literal)
    return 0

  return name.startsWith(literal) ? 1 : 2
}

// A page of the icon names of a set, or of a list of names, matching `query`: the names holding it first (the exact name, then names starting with it, then the rest), then the icons a related word, a completion or a respelling names, best first.
export function findIcons(source: readonly string[] | IconifyNames, query: string, page: IconPage = {}): string[] {
  const { limit = Infinity, offset = 0 } = page
  const needle = query.trim().toLowerCase()
  const index = indexOf(source)
  const { names } = index
  const literal = needle.replace(SPACES, '-')
  const literals = names.filter(name => name.includes(literal)).sort((a, b) => literalRank(a, literal) - literalRank(b, literal))
  const scores = new Map<string, number>()

  const credit = (word: string, weight: number) => {
    for (const name of index.byWord.get(word) ?? [])
      scores.set(name, (scores.get(name) ?? 0) + weight / index.wordCount.get(name)!)
  }

  for (const word of nameWords(needle)) {
    for (const [reading, weight] of readings(word, index)) {
      credit(reading, weight * OWN_WEIGHT)

      for (const [related, strength] of relatedWords(reading))
        credit(related, weight * strength)
    }
  }

  const shown = new Set(literals)
  const related = [...scores]
    .filter(([name]) => !shown.has(name))
    .sort((a, b) => b[1] - a[1] || index.order.get(a[0])! - index.order.get(b[0])!)
    .map(([name]) => name)

  return [...literals, ...related].slice(offset, offset + limit)
}
