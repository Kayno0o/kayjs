import { ARRIVAL_PARAM } from './arrival'
import { withBase } from './base'

// What `kay build` writes with `search` on: the manifest naming the index of the build and each language's, served revalidated, and the index under a directory named by its hash, served for good.
export const SEARCH_MANIFEST = '/_kay/search.json'
export const SEARCH_DIR = '/_kay/search/'
// Sections per file of their texts, of which a query loads those of its best hits alone.
export const SEARCH_CHUNK = 16
// A word of one letter is left out of the index, and out of a query.
export const MIN_WORD = 2

const WORD = /[\p{L}\p{N}]+/gu

// Soft hyphens, zero-width joiners and byte order marks, dropped from a word they sit in, in the index and the query alike; a zero-width space parts words, as in Thai.
// The zero-width joiner stays last: anywhere else, no-misleading-character-class reads it as joining its neighbours.
export const INVISIBLE = /[\u00AD\u200C\u2060\uFEFF\u200D]/g
const MARK = /\p{M}/gu
// Characters of text kept on either side of the first word found.
const SNIPPET_BEFORE = 50
const SNIPPET_LENGTH = 160

// The most words of a query, and the most characters of each, a hit's link carries for the page it opens to mark.
export const ARRIVAL_WORDS = 8
export const ARRIVAL_WORD_LENGTH = 64
// A word only starting with what was typed counts for less than the word itself, the more so the less of it was typed: `island` finds `Islands` nearly as well as `island`.
const PREFIX_FACTOR = 0.7

export interface SearchManifest {
  dir: string
  // Each language's index, by the `lang` of its pages' `html`.
  langs: Record<string, number>
}

export interface SearchLanguage {
  shards: string[]
  sections: number
}

export interface SearchSection {
  page: string
  heading?: string | undefined
  href: string
  text: string
}

export interface SearchHit {
  // The page's `h1`, or its `title` without one.
  page: string
  // The heading the text sits under, undefined for the text above the page's first one.
  heading?: string | undefined
  // The heading split into parts as `snippet` is, each word searched for marked, so a hit found by its heading shows why.
  headingParts?: SearchPart[] | undefined
  // The page's path, with the words searched for for the page to mark and the heading's anchor: a link rendering it puts it under the site's base.
  href: string
  // About a line of the text around the first word found, each part saying whether it is one searched for.
  snippet: SearchPart[]
  // How many more words searched for the text holds past its snippet.
  more: number
  score: number
}

export interface SearchPart {
  text: string
  hit: boolean
}

export interface SearchResults {
  // The latest query's hits, kept until the next one's arrive.
  hits: () => SearchHit[]
  loading: () => boolean
  // Why the index could not load for the latest query.
  error: () => Error | undefined
}

export interface SearchOptions {
  // The most hits returned, 20 by default.
  limit?: number | undefined
  // The language whose index is searched, the page's own `lang` by default.
  lang?: string | undefined
}

// The index files a document loaded, kept while it lives.
const loadedBy = new WeakMap<Document, Map<string, Promise<unknown>>>()

// The words of a text as the index holds them: lower case, accents dropped.
export function searchWords(text: string): string[] {
  return fold(text).match(WORD) ?? []
}

// The file holding the index's words starting as `word` does, by its first two letters, or three where two would make a large one.
export function searchShard(word: string, letters = MIN_WORD): string {
  return [...word].slice(0, letters).map(char => char.codePointAt(0)!.toString(36)).join('-')
}

// Searches the pages `kay build` indexed with `search` on, loading only the words the query starts and the texts of its best hits; every word has to be found in a section, as a word or the start of one.
export async function searchSite(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
  const terms = [...new Set(searchWords(query))].filter(term => term.length >= MIN_WORD)

  if (terms.length === 0 || typeof document === 'undefined')
    return []

  const manifest = await load<SearchManifest>(SEARCH_MANIFEST)
  const lang = options.lang ?? document.documentElement.lang
  const region = lang.indexOf('-')
  const id = manifest.langs[lang] ?? manifest.langs[region === -1 ? lang : lang.slice(0, region)] ?? Object.values(manifest.langs)[0]

  if (id === undefined)
    return []

  const dir = `${SEARCH_DIR}${manifest.dir}/${id}/`
  const language = await load<SearchLanguage>(`${dir}index.json`)
  const shards = new Set(language.shards)
  const found = await Promise.all(terms.map(async term => termScores(dir, shards, term)))
  const [fewest, ...others] = found.sort((a, b) => a.size - b.size)
  const scored: [number, number][] = []

  for (const [section, score] of fewest!) {
    let total = score

    for (const other of others) {
      const more = other.get(section)

      if (more === undefined) {
        total = -1

        break
      }

      total += more
    }

    if (total >= 0)
      scored.push([section, total])
  }

  const best = scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, options.limit ?? 20)
  const chunks = new Map(await Promise.all([...new Set(best.map(([section]) => Math.floor(section / SEARCH_CHUNK)))].map(async chunk => [chunk, await load<SearchSection[]>(`${dir}t-${chunk}.json`)] as const)))

  return best.map(([section, score]) => {
    const { page, heading, href, text } = chunks.get(Math.floor(section / SEARCH_CHUNK))![section % SEARCH_CHUNK]!

    return { page, ...heading !== undefined && { heading, headingParts: marked(heading, wordHits(heading, terms), 0, heading.length) }, href: arrivalHref(href, terms), ...snippet(text, terms), score }
  })
}

// The hit's link with the words searched for, before its anchor.
function arrivalHref(href: string, terms: string[]): string {
  const at = href.indexOf('#')
  const path = at === -1 ? href : href.slice(0, at)
  const words = terms.slice(0, ARRIVAL_WORDS).map(term => term.slice(0, ARRIVAL_WORD_LENGTH)).join(' ')

  return `${path}?${ARRIVAL_PARAM}=${encodeURIComponent(words).replaceAll('%20', '+')}${at === -1 ? '' : href.slice(at)}`
}

// Each section holding a word the term starts, scored by the best such word.
async function termScores(dir: string, shards: Set<string>, term: string): Promise<Map<number, number>> {
  const scores = new Map<number, number>()
  const two = searchShard(term)
  const longer = [...shards].filter(shard => shard.startsWith(`${two}-`))
  // A term of three letters or more needs only the file of its first three when two letters were split; one of two needs them all.
  let files = [two]

  if (longer.length > 0)
    files = term.length > MIN_WORD ? [searchShard(term, MIN_WORD + 1)] : [two, ...longer]

  const found = await Promise.all(files.filter(shard => shards.has(shard)).map(async shard => load<Record<string, number[]>>(`${dir}w-${shard}.json`)))

  for (const [word, postings] of found.flatMap(words => Object.entries(words))) {
    if (!word.startsWith(term))
      continue

    const factor = word === term ? 1 : PREFIX_FACTOR + (1 - PREFIX_FACTOR) * term.length / word.length

    for (let i = 0; i < postings.length; i += 2) {
      const score = postings[i + 1]! * factor

      if (score > (scores.get(postings[i]!) ?? 0))
        scores.set(postings[i]!, score)
    }
  }

  return scores
}

// A file of the index, once per page load; one that fails is asked again next time, as a new build may have replaced it.
async function load<T>(path: string): Promise<T> {
  let loaded = loadedBy.get(document)

  if (!loaded)
    loadedBy.set(document, loaded = new Map<string, Promise<unknown>>())

  let found = loaded.get(path)

  if (!found) {
    found = fetchJson(path)
    loaded.set(path, found)
  }

  try {
    return await found as T
  }
  catch (error) {
    loaded.clear()

    throw error
  }
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(withBase(path))

  if (!response.ok)
    throw new Error(`kay: the search index answered ${response.status} for ${path}; \`kay build\` writes it when kay.config.ts sets \`search: true\`, and \`kay dev\` has none`)

  return response.json()
}

function fold(text: string): string {
  return text.normalize('NFKD').replace(MARK, '').replace(INVISIBLE, '').toLowerCase()
}

// About a line around the first word found, each word starting as a term does marked, and how many such words lie past it.
function snippet(text: string, terms: string[]): { snippet: SearchPart[], more: number } {
  const hits = wordHits(text, terms)
  const start = Math.max(0, (hits[0]?.[0] ?? 0) - SNIPPET_BEFORE)
  const end = Math.min(text.length, start + SNIPPET_LENGTH)

  return {
    snippet: [...start > 0 ? [{ text: '…', hit: false }] : [], ...marked(text, hits, start, end), ...end < text.length ? [{ text: '…', hit: false }] : []],
    more: hits.filter(([hitStart]) => hitStart >= end).length,
  }
}

// Where each word starting as a term does sits in the text, by the term's length.
export function wordHits(text: string, terms: string[]): [number, number][] {
  // Folding can change a character's length, so each folded character keeps the index of the one it came from.
  let folded = ''
  const from: number[] = []

  for (let i = 0; i < text.length; i++) {
    const char = fold(text[i]!)

    folded += char
    // Counted in UTF-16 units, as string indices are.
    from.push(...new Array<number>(char.length).fill(i))
  }

  const hits: [number, number][] = []

  for (const word of folded.matchAll(WORD)) {
    const term = terms.find(term => word[0].startsWith(term))

    if (term !== undefined)
      hits.push([from[word.index]!, from[word.index + term.length - 1]! + 1])
  }

  return hits
}

// The text from `start` to `end` in parts, the hits within it marked.
function marked(text: string, hits: [number, number][], start: number, end: number): SearchPart[] {
  const parts: SearchPart[] = []
  let at = start

  for (const [hitStart, hitEnd] of hits) {
    if (hitStart < at || hitStart >= end)
      continue

    if (hitStart > at)
      parts.push({ text: text.slice(at, hitStart), hit: false })

    parts.push({ text: text.slice(hitStart, Math.min(hitEnd, end)), hit: true })
    at = Math.min(hitEnd, end)
  }

  if (at < end)
    parts.push({ text: text.slice(at, end), hit: false })

  return parts
}
