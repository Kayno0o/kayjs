import type { SearchLanguage, SearchManifest, SearchSection } from '../runtime/search'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MIN_WORD, SEARCH_CHUNK, SEARCH_DIR, SEARCH_MANIFEST, searchShard, searchWords } from '../runtime/search'
import { ASSET_PREFIX } from './assets'

// A page `kay build` rendered, and how much its words count, its `search: { weight }`.
export interface SearchPage {
  path: string
  html: string
  weight: number
}

interface Section {
  heading?: string | undefined
  anchor?: string | undefined
  text: string
}

// What each word is worth where it is found: the page's title in the text above its first heading, a heading, the page's title under one, the text.
const TITLE_WEIGHT = 12
const HEADING_WEIGHT = 10
const PAGE_WEIGHT = 6
const TEXT_WEIGHT = 2
// A word repeated in a text counts a little more, up to four times.
const REPEAT_WEIGHT = 0.5
const REPEATS = 4

const SKIPPED = 'script, style, template, noscript, nav, footer, svg, [data-search="false"]'
// Block elements part words; an inline one such as `code` sits inside a sentence.
const BLOCKS = 'p, li, dt, dd, td, th, tr, br, div, pre, blockquote, section, article, figcaption, h1, h2, h3, h4, h5, h6'
const ENTITY = /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }
const SPACES = /\s+/g
// Characters past which the file of a two-letter start is split by three.
const SHARD_SIZE = 16_384
const MAIN = /<main[\s>]/

// Writes the search index of the pages a build rendered under the browser build, each language's apart, and the manifest naming it.
export async function writeSearchIndex(clientDir: string, pages: SearchPage[]): Promise<void> {
  const byLang = new Map<string, SearchSection[][]>()
  const weights = new Map<SearchSection[], number>()

  for (const page of pages) {
    const { lang, sections } = readPage(page)
    const list = byLang.get(lang) ?? []

    list.push(sections)
    weights.set(sections, page.weight)
    byLang.set(lang, list)
  }

  const files = new Map<string, unknown>()
  const manifest: SearchManifest = { dir: '', langs: {} }

  for (const [id, [lang, sectionsOf]] of [...byLang].entries()) {
    const words = new Map<string, number[]>()
    const all: SearchSection[] = []

    for (const sections of sectionsOf) {
      for (const section of sections) {
        for (const [word, score] of sectionScores(section, sections[0]!.page, section === sections[0], weights.get(sections)!)) {
          const postings = words.get(word) ?? []

          postings.push(all.length, score)
          words.set(word, postings)
        }

        all.push(section)
      }
    }

    const shards = new Map<string, Record<string, number[]>>()
    const put = (shard: string, word: string, postings: number[]) => {
      const entries = shards.get(shard) ?? {}

      entries[word] = postings
      shards.set(shard, entries)
    }

    for (const [word, postings] of [...words].sort(([a], [b]) => a.localeCompare(b)))
      put(searchShard(word), word, postings)

    // A large file of two letters is split by three, its words of two letters left in it.
    for (const [shard, entries] of shards) {
      if (JSON.stringify(entries).length <= SHARD_SIZE)
        continue

      shards.delete(shard)

      for (const [word, postings] of Object.entries(entries))
        put([...word].length > MIN_WORD ? searchShard(word, MIN_WORD + 1) : shard, word, postings)
    }

    const language: SearchLanguage = { shards: [...shards.keys()], sections: all.length }

    files.set(`${id}/index.json`, language)

    for (const [shard, entries] of shards)
      files.set(`${id}/w-${shard}.json`, entries)

    for (let chunk = 0; chunk * SEARCH_CHUNK < all.length; chunk++)
      files.set(`${id}/t-${chunk}.json`, all.slice(chunk * SEARCH_CHUNK, (chunk + 1) * SEARCH_CHUNK))

    manifest.langs[lang] = id
  }

  const texts = new Map([...files].map(([name, value]) => [name, JSON.stringify(value)]))
  const hasher = new Bun.CryptoHasher('sha256')

  for (const [name, text] of texts)
    hasher.update(`${name}\0${text}\0`)

  manifest.dir = hasher.digest('hex').slice(0, 12)

  const dir = join(clientDir, SEARCH_DIR.slice(ASSET_PREFIX.length))

  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await Promise.all([...texts].map(async ([name, text]) => Bun.write(join(dir, manifest.dir, name), text)))
  await Bun.write(join(clientDir, SEARCH_MANIFEST.slice(ASSET_PREFIX.length)), JSON.stringify(manifest))
}

// Each word of a section with what it is worth there, the best place it is found deciding.
function sectionScores(section: SearchSection, page: string, top: boolean, weight: number): Map<string, number> {
  const scores = new Map<string, number>()
  const add = (text: string | undefined, worth: (count: number) => number) => {
    const counts = new Map<string, number>()

    for (const word of searchWords(text ?? '')) {
      if (word.length >= MIN_WORD)
        counts.set(word, (counts.get(word) ?? 0) + 1)
    }

    for (const [word, count] of counts)
      scores.set(word, Math.max(scores.get(word) ?? 0, worth(count)))
  }

  add(page, () => top ? TITLE_WEIGHT : PAGE_WEIGHT)
  add(section.heading, () => HEADING_WEIGHT)
  add(section.text, count => TEXT_WEIGHT + REPEAT_WEIGHT * (Math.min(count, REPEATS) - 1))

  for (const [word, score] of scores)
    scores.set(word, Math.round(score * weight * 10) / 10)

  return scores
}

// The page's language, its title and its sections: the text above its first `h2` to `h4`, then each of those with the text under it, read from its `main`, or its `body` without one.
function readPage(page: SearchPage): { lang: string, sections: SearchSection[] } {
  const scoped = MAIN.test(page.html)
  const sections: Section[] = [{ text: '' }]
  let lang = ''
  let title = ''
  let h1 = ''
  let inMain = 0
  let skipped = 0
  let target: 'title' | 'h1' | 'heading' | 'text' = 'text'

  new HTMLRewriter()
    .on('html', { element: (element) => { lang = element.getAttribute('lang') ?? '' } })
    .on('head > title', {
      element: (element) => {
        target = 'title'
        element.onEndTag(() => {
          target = 'text'
        })
      },
    })
    .on('main', {
      element: (element) => {
        inMain++
        element.onEndTag(() => {
          inMain--
        })
      },
    })
    .on(SKIPPED, {
      element: (element) => {
        skipped++
        element.onEndTag(() => {
          skipped--
        })
      },
    })
    .on(BLOCKS, { element: () => { sections.at(-1)!.text += ' ' } })
    .on('h1', {
      element: (element) => {
        target = 'h1'
        element.onEndTag(() => {
          target = 'text'
        })
      },
    })
    .on('h2, h3, h4', {
      element: (element) => {
        if (skipped > 0 || (scoped && inMain === 0))
          return

        sections.push({ heading: '', anchor: element.getAttribute('id') ?? undefined, text: '' })
        target = 'heading'
        element.onEndTag(() => {
          target = 'text'
        })
      },
    })
    .onDocument({
      text: (chunk) => {
        if (target === 'title') {
          title += chunk.text

          return
        }

        if (skipped > 0 || (scoped && inMain === 0))
          return

        if (target === 'h1')
          h1 += chunk.text
        else if (target === 'heading')
          sections.at(-1)!.heading += chunk.text
        else
          sections.at(-1)!.text += chunk.text
      },
    })
    .transform(page.html)

  const name = plain(h1) || plain(title)

  return {
    lang,
    sections: sections.map(section => ({ page: name, ...section.heading !== undefined && { heading: plain(section.heading) }, href: section.anchor === undefined ? page.path : `${page.path}#${section.anchor}`, text: plain(section.text) })).filter((section, index) => index === 0 || section.heading !== '' || section.text !== ''),
  }
}

function plain(html: string): string {
  return html.replace(ENTITY, (entity, decimal?: string, hex?: string, name?: string) => decimal !== undefined ? String.fromCodePoint(Number(decimal)) : hex !== undefined ? String.fromCodePoint(Number.parseInt(hex, 16)) : ENTITIES[name!.toLowerCase()] ?? entity).replace(SPACES, ' ').trim()
}
