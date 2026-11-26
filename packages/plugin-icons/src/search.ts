import { byStem, nameParts, nameWords, stem } from './name-words'
import { completions, MOST, respellings } from './spelling'
import { relatedWords, tableCompletions, tableForm, tableRespellings } from './table'

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
  // Each stem of the names' words to its plain form, made on the first word the names and the table both miss.
  stems?: Map<string, string>
}

const SPACES = /\s+/g
const BOUNDARY = /[^a-z0-9]/
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

// The bit of the query word at `at`, words past the 31st sharing the last bit a number holds.
function bit(at: number): number {
  return 1 << Math.min(at, 30)
}

function ones(bits: number): number {
  let count = 0

  for (let rest = bits; rest !== 0; rest &= rest - 1)
    count++

  return count
}


// What a typed word stands for, with its weight: itself when the names or the table know it, else the three most used of its completions and the three closest of its respellings, the most used first among equals.
// The table's side of a typed word is read once for every set; a word reached both ways keeps the larger weight.
function readings(word: string, index: Index): Map<string, number> {
  if (index.byWord.has(word) || relatedWords(word).length > 0)
    return new Map([[word, 1]])

  index.stems ??= byStem(index.byWord.keys())
  const form = index.stems.get(stem(word)) ?? tableForm(word)

  if (form !== undefined)
    return new Map([[form, 1]])

  const uses = (candidate: string) => index.byWord.get(candidate)?.length ?? 0
  // A word of the names comes first, by how many hold it; a word only the table knows, by how many names its related words reach.
  const completed = [...new Set([...completions(word, index.byWord.keys()), ...tableCompletions(word)])]
    .map(candidate => index.byWord.has(candidate)
      ? { candidate, named: 1, reached: uses(candidate) }
      : { candidate, named: 0, reached: relatedWords(candidate).reduce((reached, [related]) => reached + uses(related), 0) })
    .sort((a, b) => b.named - a.named || b.reached - a.reached || a.candidate.length - b.candidate.length)
    .slice(0, MOST)
    .map(({ candidate }) => candidate)
  const respelled = [...new Map([...tableRespellings(word), ...respellings(word, index.byWord.keys())])]
    .sort((a, b) => a[1] - b[1] || uses(b[0]) - uses(a[0]) || (a[0] < b[0] ? -1 : 1))
    .slice(0, MOST)
  const found = new Map(respelled.map(([candidate]) => [candidate, RESPELLING_WEIGHT]))

  for (const candidate of completed)
    found.set(candidate, Math.max(found.get(candidate) ?? 0, COMPLETION_WEIGHT))

  return found
}

// How a name holds the query as typed: the name itself, its first words, whole words further in, every query word in any order, the start of a word, or inside a word.
const enum Held { Name, FirstWords, Words, EveryWord, WordStart, InsideWord }

function held(name: string, literal: string): Held | undefined {
  if (name === literal)
    return Held.Name

  let best: Held | undefined

  for (let at = name.indexOf(literal); at !== -1 && at < name.length; at = name.indexOf(literal, at + 1)) {
    const end = at + literal.length
    const startsWord = at === 0 || BOUNDARY.test(name[at - 1]!)
    const endsWord = end === name.length || BOUNDARY.test(name[end]!)
    const rank = !startsWord ? Held.InsideWord : !endsWord ? Held.WordStart : at === 0 ? Held.FirstWords : Held.Words

    best = best === undefined ? rank : Math.min(best, rank)
  }

  return best
}

// The names holding each of several words whole, in any order.
function holdingEvery(words: string[], index: Index): Set<string> {
  if (words.length < 2)
    return new Set()

  // The names holding the word fewest names hold, kept when their own words hold the others too.
  const fewest = words.map(word => index.byWord.get(word) ?? []).reduce((a, b) => b.length < a.length ? b : a)

  return new Set(fewest.filter((name) => {
    const own = new Set(nameWords(name))

    return words.every(word => own.has(word))
  }))
}

// A page of the icon names of a set, or of a list of names, matching `query`: the names holding it as whole words first (the exact name, names starting with it, names holding it further in, names holding each of its words in any order), then names starting a word with it, then the icons a related word, a completion or a respelling names, those answering more of the query's words first, then names holding it inside a word.
export function findIcons(source: readonly string[] | IconifyNames, query: string, page: IconPage = {}): string[] {
  const { limit = Infinity, offset = 0 } = page
  if (!Number.isInteger(offset) || offset < 0 || !(limit === Infinity || (Number.isInteger(limit) && limit >= 1)))
    throw new RangeError(PAGE_REFUSAL)

  const needle = query.trim().toLowerCase()
  const index = indexOf(source)
  const { names } = index
  const literal = needle.replace(SPACES, '-')
  const typedWords = [...new Set(nameWords(needle))]
  const every = holdingEvery(typedWords, index)
  // The names holding the query, one list per way of holding it, each in the set's order.
  const byHeld: string[][] = [[], [], [], [], [], []]
  const rankOf = new Map<string, Held>()

  for (const name of names) {
    const rank = name.includes(literal) ? held(name, literal) : undefined

    if (rank !== undefined) {
      byHeld[rank]!.push(name)
      rankOf.set(name, rank)
    }
  }

  // A name holding every query word moves up to that rank unless it holds the query better already.
  const moved = new Set([...every].filter(name => (rankOf.get(name) ?? Held.InsideWord + 1) > Held.EveryWord))

  if (moved.size > 0) {
    byHeld[Held.EveryWord] = [...moved]
    byHeld[Held.WordStart] = byHeld[Held.WordStart]!.filter(name => !moved.has(name))
    byHeld[Held.InsideWord] = byHeld[Held.InsideWord]!.filter(name => !moved.has(name))
  }

  const literals = byHeld.slice(0, Held.InsideWord).flat()
  // Each credited name's score, and the query words it answers as one bit each, so a word counts once however many readings reach it.
  const scores = new Map<string, { score: number, answered: number }>()
  let answering = 0

  const credit = (word: string, weight: number) => {
    for (const name of index.byWord.get(word) ?? []) {
      const gained = weight / index.wordCount.get(name)!
      const known = scores.get(name)

      if (known === undefined) {
        scores.set(name, { score: gained, answered: answering })
      }
      else {
        known.score += gained
        known.answered |= answering
      }
    }
  }

  // Two neighbouring query words also stand for the word they make joined when it is known, as `sign out` for `signout`, answering both; its related words leave out those two, which answer one word only.
  const apart = typedWords.map((typed, i) => ({ typed, bits: bit(i), parts: [] as string[] }))
  const joined = typedWords.slice(1)
    .map((word, i) => ({ typed: typedWords[i]! + word, bits: bit(i) | bit(i + 1), parts: [typedWords[i]!, word] }))
    .filter(({ typed }) => index.byWord.has(typed) || relatedWords(typed).length > 0)

  for (const { typed, bits, parts } of [...apart, ...joined]) {
    answering = bits

    for (const [reading, weight] of readings(typed, index)) {
      credit(reading, weight * OWN_WEIGHT)

      for (const [related, strength] of relatedWords(reading)) {
        if (!parts.includes(related))
          credit(related, weight * strength)
      }
    }
  }

  const shown = new Set(literals)
  const related = [...scores]
    .filter(([name]) => !shown.has(name))
    .map(([name, { score, answered }]) => ({ name, score, answered: ones(answered) }))
    .sort((a, b) => b.answered - a.answered || b.score - a.score || index.order.get(a.name)! - index.order.get(b.name)!)
    .map(({ name }) => name)

  // A name holding the query only inside a word, as `spinner` holds `pin`, comes last.
  const shownToo = new Set(related)
  const inside = byHeld[Held.InsideWord]!.filter(name => !shownToo.has(name))

  return [...literals, ...related, ...inside].slice(offset, offset + limit)
}
