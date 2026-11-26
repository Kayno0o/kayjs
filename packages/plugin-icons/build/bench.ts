// Scores the search on tables that never saw the set they are tested on: learned from one set's tags (plus phosphor's and the other sets' aliases), queried with the other set's.
// A case is a tag naming at most 5 icons that the icon's name does not hold, so the plain substring search scores about 0; each suite reports the share found in the first 10 (what `kay icons-find` prints) and 50 (a picker's first page), and the mean reciprocal rank.
// The typed queries of queries.ts add multi-word cases and count how often an icon they must not lead with comes first.
import type { Tagged } from './learn'
import type { Query } from './queries'
import { findIcons } from '../src/search'
import { replaceTable } from '../src/table'
import { aliasTags, fromMeaning, fromTags, iconifyNameWords, lucideTags, merge, modelWords, phosphorTags, setWords, tablerTags } from './learn'
import { QUERIES } from './queries'
import { FLOOR, MEANING_WEIGHT, NEIGHBOURS } from './settings'

interface Case { query: string, target: string }

const PAGE = 50
const FOUND = 10
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

function percent(share: number): string {
  return `${(share * 100).toFixed(1).padStart(5)}%`
}

// Recall at 10 and 50 and the mean reciprocal rank of the first answer, over cases each holding the names that answer it.
function rank(names: string[], suite: { query: string, answers: string[] }[]): string {
  let at10 = 0
  let at50 = 0
  let reciprocal = 0

  for (const { query, answers } of suite) {
    const at = findIcons(names, query, { limit: PAGE }).findIndex(name => answers.includes(name))

    if (at === -1)
      continue
    at50++
    if (at < FOUND)
      at10++
    reciprocal += 1 / (at + 1)
  }

  return `R@10 ${percent(at10 / suite.length)} R@50 ${percent(at50 / suite.length)} MRR ${(reciprocal / suite.length).toFixed(3)}`
}

function score(names: string[], suite: Case[]): string {
  return rank(names, suite.map(({ query, target }) => ({ query, answers: [target] })))
}

function scoreQueries(names: string[], queries: Query[]): string {
  const known = new Set(names)
  const held = queries.filter(({ answers }) => answers.some(name => known.has(name)))
  const wrongFirst = held.filter(({ query, never = [] }) => never.includes(findIcons(names, query, { limit: 1 })[0] ?? ''))

  return `${rank(names, held)} wrong first ${wrongFirst.length}/${held.length}${wrongFirst.length > 0 ? ` (${wrongFirst.map(({ query }) => query).join(', ')})` : ''}`
}

const sets = { tabler: await tablerTags(), lucide: await lucideTags() }
const phosphor = await phosphorTags()
const candidates = [...await iconifyNameWords()]
const common = await modelWords()

for (const [train, test] of [['tabler', 'lucide'], ['lucide', 'tabler']] as const) {
  const suites = cases(sets[test])
  // Every source the table learns from, minus the test set's tags and aliases, which would hand the answers over.
  const learned = [sets[train], phosphor, await aliasTags([test])]
  const tags = fromTags(learned)
  const keys = [...new Set([...common, ...setWords(learned), ...candidates])]
  const meaning = await fromMeaning(keys, candidates, NEIGHBOURS, FLOOR)
  const tables = {
    'none': {},
    'set tags': merge(fromTags([sets[train]]), new Map(), 0),
    'all tags': merge(tags, new Map(), 0),
    'all tags + meaning': merge(tags, meaning, MEANING_WEIGHT),
  }

  console.log(`\n${train} tags -> ${test} (${Object.entries(suites).map(([kind, list]) => `${list.length} ${kind}`).join(', ')})`)

  const names = [...sets[test].keys()]

  for (const [label, table] of Object.entries(tables)) {
    replaceTable(table)
    console.log(`  ${label} (${Object.keys(table).length} words)`)
    for (const [kind, suite] of Object.entries(suites))
      console.log(`    ${kind.padEnd(8)} ${score(names, suite)}`)
    console.log(`    ${'queries'.padEnd(8)} ${scoreQueries(names, QUERIES)}`)
  }
}
