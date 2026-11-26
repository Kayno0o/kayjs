import { nameParts, nameWords } from './name-words'
import { completions, MOST, respellings } from './spelling'
import { relatedWords, tableCompletions, tableRespellings } from './table'

export { relatedWords }

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
}

const SPACES = /\s+/g
// A word typed as given counts twice what a related word, a completion or a respelling brings.
const OWN_WEIGHT = 2
const COMPLETION_WEIGHT = 0.7
const RESPELLING_WEIGHT = 0.8
const PAGE_REFUSAL = '@kayjs/icons: findIcons pages from a whole offset of 0 or more, by a whole limit of 1 or more: clamp the page a request asks for before searching.'

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

    wordCount.set(name, nameParts(name))

    for (const word of words) {
      const list = byWord.get(word)

      if (list)
        list.push(name)
      else
        byWord.set(word, [name])
    }
  }

  const index = { names, byWord, wordCount, order: new Map(names.map((name, i) => [name, i])) }

  indexes.set(source, index)

  return index
}

function isNames(source: readonly string[] | IconifyNames): source is readonly string[] {
  return Array.isArray(source)
}


// What a typed word stands for, with its weight: itself when the names or the table know it, else the three most used of its completions and the three closest of its respellings, the most used first among equals.
// The table's side of a typed word is read once for every set; a word reached both ways keeps the larger weight.
function readings(word: string, index: Index): Map<string, number> {
  if (index.byWord.has(word) || relatedWords(word).length > 0)
    return new Map([[word, 1]])

  const uses = (candidate: string) => index.byWord.get(candidate)?.length ?? 0
  const completed = [...new Set([...completions(word, index.byWord.keys()), ...tableCompletions(word)])]
    .sort((a, b) => uses(b) - uses(a) || a.length - b.length)
    .slice(0, MOST)
  const respelled = [...new Map([...tableRespellings(word), ...respellings(word, index.byWord.keys())])]
    .sort((a, b) => a[1] - b[1] || uses(b[0]) - uses(a[0]) || (a[0] < b[0] ? -1 : 1))
    .slice(0, MOST)
  const found = new Map(respelled.map(([candidate]) => [candidate, RESPELLING_WEIGHT]))

  for (const candidate of completed)
    found.set(candidate, Math.max(found.get(candidate) ?? 0, COMPLETION_WEIGHT))

  return found
}

function literalRank(name: string, literal: string): number {
  if (name === literal)
    return 0

  return name.startsWith(literal) ? 1 : 2
}

// A page of the icon names of a set, or of a list of names, matching `query`: the names holding it first (the exact name, then names starting with it, then the rest), then the icons a related word, a completion or a respelling names, those answering more of the query's words first, then the best scored.
export function findIcons(source: readonly string[] | IconifyNames, query: string, page: IconPage = {}): string[] {
  const { limit = Infinity, offset = 0 } = page
  if (!Number.isInteger(offset) || offset < 0 || !(limit === Infinity || (Number.isInteger(limit) && limit >= 1)))
    throw new RangeError(PAGE_REFUSAL)

  const needle = query.trim().toLowerCase()
  const index = indexOf(source)
  const { names } = index
  const literal = needle.replace(SPACES, '-')
  const literals = names.filter(name => name.includes(literal)).sort((a, b) => literalRank(a, literal) - literalRank(b, literal))
  // Each credited name's score, how many of the query's words it answers, and the last word that counted.
  const scores = new Map<string, { score: number, answered: number, lastTyped: number }>()
  let typedAt = 0

  const credit = (word: string, weight: number) => {
    for (const name of index.byWord.get(word) ?? []) {
      const gained = weight / index.wordCount.get(name)!
      const known = scores.get(name)

      if (known === undefined) {
        scores.set(name, { score: gained, answered: 1, lastTyped: typedAt })
      }
      else {
        known.score += gained
        if (known.lastTyped !== typedAt) {
          known.lastTyped = typedAt
          known.answered++
        }
      }
    }
  }

  for (const typed of new Set(nameWords(needle))) {
    typedAt++

    for (const [reading, weight] of readings(typed, index)) {
      credit(reading, weight * OWN_WEIGHT)

      for (const [related, strength] of relatedWords(reading))
        credit(related, weight * strength)
    }
  }

  const shown = new Set(literals)
  const related = [...scores]
    .filter(([name]) => !shown.has(name))
    .sort((a, b) => b[1].answered - a[1].answered || b[1].score - a[1].score || index.order.get(a[0])! - index.order.get(b[0])!)
    .map(([name]) => name)

  return [...literals, ...related].slice(offset, offset + limit)
}
