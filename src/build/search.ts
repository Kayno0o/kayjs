import type { SearchLanguage, SearchManifest, SearchSection } from '../runtime/search'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { KayError } from '../compiler/errors'
import { INVISIBLE, MIN_WORD, SEARCH_CHUNK, SEARCH_DIR, SEARCH_MANIFEST, searchShard, searchWords } from '../runtime/search'
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

// A page as the index reads it: its language, and its sections with what their words are worth.
interface ReadPage {
  lang: string
  sections: SearchSection[]
  weight: number
}

// What each word is worth where it is found: the page's title in the text above its first heading, a heading, the page's title under one, the text.
const TITLE_WEIGHT = 12
const HEADING_WEIGHT = 10
const PAGE_WEIGHT = 6
const TEXT_WEIGHT = 2
// A word of a title or heading counts up to this much more as it makes up more of it: `kay mcp` before `An API route is an MCP tool only when...`, a heading staying below a title.
const FOCUS_WEIGHT = 1.5
// A word counts up to this much more in every section of a page the more of its sections hold it, so the page about it comes before one naming it once, below any heading naming it.
const TOPIC_WEIGHT = 2
// A word repeated in a text counts a little more, up to four times.
const REPEAT_WEIGHT = 0.5
const REPEATS = 4

const SKIPPED = 'script, style, template, noscript, nav, footer, svg, [data-search="false"]'
// Block elements part words, as does a button left out between two; an inline one such as `code` sits inside a sentence.
const BLOCKS = 'p, li, dt, dd, td, th, tr, br, div, pre, blockquote, section, article, figcaption, button, h1, h2, h3, h4, h5, h6'
const ENTITY = /&(?:#(\d+)|#x([\da-f]+)|([a-z]+\d*));/gi
// The named entities a page may hold: HTML's own, Latin-1's from `nbsp` (U+00A0) on, and typography's.
const LATIN_1 = 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  OElig: 'Œ',
  oelig: 'œ',
  Scaron: 'Š',
  scaron: 'š',
  Yuml: 'Ÿ',
  ndash: '–',
  mdash: '\u2014',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  hellip: '…',
  ZeroWidthSpace: '\u200B',
  zwnj: '\u200C',
  zwj: '\u200D',
  bull: '•',
  prime: '′',
  Prime: '″',
  euro: '€',
  trade: '™',
  larr: '←',
  rarr: '→',
  ...Object.fromEntries(LATIN_1.split(' ').map((name, index) => [name, String.fromCodePoint(0xA0 + index)])),
}
const MAX_CODE_POINT = 0x10FFFF
// What a link to its own heading shows beside the heading's text, left out of it: a mark, or nothing visible.
const ANCHOR_MARKS = /^[\s#¶§\u200B]*$/
// A zero-width space parts words as a space does, which `\s` and `trim()` leave out.
const SPACES = /[\s\u200B]+/g
// Characters past which the file of a two-letter start is split by three.
const SHARD_SIZE = 16_384
const MAIN = /<main[\s>]/

// Writes the search index of the pages a build rendered under the browser build, each language's apart, and the manifest naming it.
export async function writeSearchIndex(clientDir: string, pages: SearchPage[]): Promise<void> {
  const byLang = new Map<string, ReadPage[]>()

  for (const page of pages) {
    const read = readPage(page)
    const ofLang = byLang.get(read.lang)

    if (ofLang)
      ofLang.push(read)
    else
      byLang.set(read.lang, [read])
  }

  const files = new Map<string, unknown>()
  const manifest: SearchManifest = { dir: '', langs: {} }
  let id = 0

  for (const [lang, read] of byLang) {
    const words = new Map<string, number[]>()
    const all: SearchSection[] = []

    for (const { sections, weight } of read) {
      const scored = sections.map(section => sectionScores(section, sections[0]!.page, section === sections[0]))
      const holding = new Map<string, number>()

      for (const { own } of scored) {
        for (const word of own)
          holding.set(word, (holding.get(word) ?? 0) + 1)
      }

      for (const [index, { scores }] of scored.entries()) {
        for (const [word, score] of scores) {
          const postings = words.get(word) ?? []
          const topic = TOPIC_WEIGHT * (holding.get(word) ?? 0) / sections.length

          postings.push(all.length, Math.round((score + topic) * weight * 10) / 10)
          words.set(word, postings)
        }

        all.push(sections[index]!)
      }
    }

    const byTwo = new Map<string, Record<string, number[]>>()
    const shards = new Map<string, Record<string, number[]>>()
    const put = (into: Map<string, Record<string, number[]>>, shard: string, word: string, postings: number[]) => {
      const entries = into.get(shard) ?? {}

      entries[word] = postings
      into.set(shard, entries)
    }

    for (const [word, postings] of [...words].sort(([a], [b]) => a < b ? -1 : 1))
      put(byTwo, searchShard(word), word, postings)

    // A large file of two letters is split by three, its words of two letters left in it; a file of three letters stays whole, however large, as a query knows no longer one.
    for (const [shard, entries] of byTwo) {
      if (JSON.stringify(entries).length <= SHARD_SIZE) {
        shards.set(shard, entries)

        continue
      }

      for (const [word, postings] of Object.entries(entries))
        put(shards, [...word].length > MIN_WORD ? searchShard(word, MIN_WORD + 1) : shard, word, postings)
    }

    const language: SearchLanguage = { shards: [...shards.keys()], sections: all.length }

    files.set(`${id}/index.json`, language)

    for (const [shard, entries] of shards)
      files.set(`${id}/w-${shard}.json`, entries)

    for (let chunk = 0; chunk * SEARCH_CHUNK < all.length; chunk++)
      files.set(`${id}/t-${chunk}.json`, all.slice(chunk * SEARCH_CHUNK, (chunk + 1) * SEARCH_CHUNK))

    manifest.langs[lang] = id++
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

// Each word of a section with what it is worth there, the best place it is found deciding, and the words of its own heading and text, its page's title aside.
function sectionScores(section: SearchSection, page: string, top: boolean): { scores: Map<string, number>, own: Set<string> } {
  const scores = new Map<string, number>()
  const own = new Set<string>()
  const add = (text: string | undefined, worth: (count: number, share: number) => number) => {
    const words = searchWords(text ?? '').filter(word => word.length >= MIN_WORD)
    const counts = new Map<string, number>()

    for (const word of words)
      counts.set(word, (counts.get(word) ?? 0) + 1)

    for (const [word, count] of counts)
      scores.set(word, Math.max(scores.get(word) ?? 0, worth(count, count / words.length)))
  }

  add(page, (_, share) => (top ? TITLE_WEIGHT : PAGE_WEIGHT) + FOCUS_WEIGHT * share)
  add(section.heading, (_, share) => HEADING_WEIGHT + FOCUS_WEIGHT * share)
  add(section.text, count => TEXT_WEIGHT + REPEAT_WEIGHT * (Math.min(count, REPEATS) - 1))

  for (const word of searchWords(`${section.heading ?? ''} ${section.text}`)) {
    if (word.length >= MIN_WORD)
      own.add(word)
  }

  return { scores, own }
}

// The page's language, its title and its sections: the text above its first `h2` to `h4`, then each of those with the text under it, read from its `main`, or its `body` without one.
function readPage(page: SearchPage): ReadPage {
  const scoped = MAIN.test(page.html)
  const sections: Section[] = [{ text: '' }]
  let lang = ''
  let title = ''
  let h1 = ''
  let inMain = 0
  let skipped = 0
  let target: 'title' | 'h1' | 'heading' | 'anchor' | 'text' = 'text'
  let anchor = ''
  const toText = () => {
    target = 'text'
  }

  const rewriter = new HTMLRewriter()
    .on('html', { element: (element) => { lang = element.getAttribute('lang') ?? '' } })
    .on('head > title', {
      element: (element) => {
        target = 'title'
        atEnd(element, toText)
      },
    })
    .on('main', {
      element: (element) => {
        inMain++
        atEnd(element, () => {
          inMain--
        })
      },
    })
    .on(SKIPPED, {
      element: (element) => {
        skipped++
        atEnd(element, () => {
          skipped--
        })
      },
    })
    .on('button', {
      // A control's label, but for an accordion's heading written as a button inside it.
      element: (element) => {
        if (target !== 'text')
          return

        skipped++
        atEnd(element, () => {
          skipped--
        })
      },
    })
    .on(BLOCKS, { element: () => { sections.at(-1)!.text += ' ' } })
    .on('h1', {
      element: (element) => {
        h1 += ' '
        target = 'h1'
        atEnd(element, toText)
      },
    })
    .on('h2, h3, h4', {
      element: (element) => {
        if (skipped > 0 || (scoped && inMain === 0))
          return

        sections.push({ heading: '', anchor: element.getAttribute('id') ?? undefined, text: '' })
        target = 'heading'
        atEnd(element, toText)
      },
    })
    .on('h2 a[href^="#"], h3 a[href^="#"], h4 a[href^="#"]', {
      element: (element) => {
        if (target !== 'heading')
          return

        anchor = ''
        target = 'anchor'
        atEnd(element, () => {
          if (!ANCHOR_MARKS.test(plain(anchor)))
            sections.at(-1)!.heading += anchor

          target = 'heading'
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
        else if (target === 'anchor')
          anchor += chunk.text
        else
          sections.at(-1)!.text += chunk.text
      },
    })

  try {
    rewriter.transform(page.html)
  }
  catch (error) {
    throw new KayError('search-page-unreadable', `kay: the search index could not read ${page.path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  const name = plain(h1) || plain(title)

  return {
    lang,
    weight: page.weight,
    sections: sections.map(section => ({ page: name, ...section.heading !== undefined && { heading: plain(section.heading) }, href: section.anchor === undefined ? page.path : `${page.path}#${encodeURIComponent(section.anchor)}`, text: plain(section.text) })).filter((section, index) => index === 0 || section.heading !== '' || section.text !== ''),
  }
}

// Runs `run` once the element ends: at once for one with no end tag, a void element such as `img` or a self-closing one such as `<svg/>`.
function atEnd(element: HTMLRewriterTypes.Element, run: () => void): void {
  if (element.canHaveContent && !element.selfClosing)
    element.onEndTag(run)
  else
    run()
}

function hexCode(hex: string | undefined): number | undefined {
  return hex === undefined ? undefined : Number.parseInt(hex, 16)
}

function plain(html: string): string {
  return html.replace(ENTITY, (entity, decimal?: string, hex?: string, name?: string) => {
    const code = decimal === undefined ? hexCode(hex) : Number(decimal)

    if (code === undefined)
      return ENTITIES[name!] ?? ENTITIES[name!.toLowerCase()] ?? entity

    return code <= MAX_CODE_POINT ? String.fromCodePoint(code) : entity
  }).replace(INVISIBLE, '').replace(SPACES, ' ').trim()
}
