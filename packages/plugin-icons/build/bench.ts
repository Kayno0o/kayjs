// Scores the search on tables that never saw the set they are tested on: learned from one set's tags, queried with the other set's.
// A case is a tag naming at most 5 icons that the icon's name does not hold, so the plain substring search scores about 0; a hit is the icon within the first 50, the picker's first page.
import type { Tagged } from './learn'
import { findIcons } from '../src/search'
import { replaceTable } from '../src/table'
import { fromMeaning, fromTags, iconifyNameWords, lucideTags, merge, modelWords, setWords, tablerTags } from './learn'
import { FLOOR, MEANING_WEIGHT, NEIGHBOURS } from './settings'

interface Case { query: string, target: string }

const PAGE = 50
const MOST_TAGGED = 5
const SAMPLE = 1500
const SINGLE_WORD = /^[a-z]{5,}$/
const SPACES = /\s+/g
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

// Seeded, so every run scores the same cases.
let seed = 7

function random(): number {
  seed = (seed * 16807) % 2147483647

  return seed / 2147483647
}

// One deletion, insertion or swap of neighbours, never on the first letter.
function typo(word: string): string {
  const at = 1 + Math.floor(random() * (word.length - 1))
  const kind = Math.floor(random() * 3)
  const letter = LETTERS[Math.floor(random() * LETTERS.length)]!

  if (kind === 0)
    return word.slice(0, at) + word.slice(at + 1)

  if (kind === 1)
    return word.slice(0, at) + letter + word.slice(at)

  return word.slice(0, at - 1) + word[at]! + word[at - 1]! + word.slice(at + 1)
}

function cases(test: Tagged): Record<string, Case[]> {
  const uses = new Map<string, number>()

  for (const tags of test.values()) {
    for (const tag of new Set(tags.map(tag => tag.toLowerCase().trim())))
      uses.set(tag, (uses.get(tag) ?? 0) + 1)
  }

  const tags: Case[] = []

  for (const [name, list] of test) {
    for (const tag of new Set(list.map(tag => tag.toLowerCase().trim()))) {
      if (tag.length >= 3 && uses.get(tag)! <= MOST_TAGGED && !name.includes(tag.replace(SPACES, '-')))
        tags.push({ query: tag, target: name })
    }
  }

  const single = tags.filter(({ query }) => SINGLE_WORD.test(query))
  const sample = (list: Case[]) => list.filter((_, i) => i % Math.ceil(list.length / SAMPLE) === 0)

  return {
    tag: sample(tags),
    typo: sample(single.map(({ query, target }) => ({ query: typo(query), target }))),
    prefix: sample(single.map(({ query, target }) => ({ query: query.slice(0, Math.max(3, Math.ceil(query.length * 0.6))), target }))),
  }
}

function score(names: string[], suite: Case[]): string {
  let hits = 0

  for (const { query, target } of suite) {
    if (findIcons(names, query, { limit: PAGE }).includes(target))
      hits++
  }

  return `${(hits / suite.length * 100).toFixed(1).padStart(5)}%`
}

const sets = { tabler: await tablerTags(), lucide: await lucideTags() }
const candidates = [...await iconifyNameWords()]
const common = await modelWords()

for (const [train, test] of [['tabler', 'lucide'], ['lucide', 'tabler']] as const) {
  const suites = cases(sets[test])
  const tags = fromTags([sets[train]])
  // The words a search may be typed with, minus the test set's tags, which would hand the answers over.
  const keys = [...new Set([...common, ...setWords([sets[train]]), ...candidates])]
  const meaning = await fromMeaning(keys, candidates, NEIGHBOURS, FLOOR)
  const tables = { 'none': {}, 'tags': merge(tags, new Map(), 0), 'tags + meaning': merge(tags, meaning, MEANING_WEIGHT) }

  console.log(`\n${train} tags -> ${test} (${Object.entries(suites).map(([kind, list]) => `${list.length} ${kind}`).join(', ')})`)

  const names = [...sets[test].keys()]

  for (const [label, table] of Object.entries(tables)) {
    replaceTable(table)
    console.log(`  ${label.padEnd(15)} ${Object.entries(suites).map(([kind, suite]) => `${kind} ${score(names, suite)}`).join('  ')}`)
  }
}
