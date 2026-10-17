import { ARRIVAL_HIGHLIGHT, ARRIVAL_PARAM, arrives } from './arrival'
import { ARRIVAL_WORD_LENGTH, ARRIVAL_WORDS, MIN_WORD, searchWords, wordHits } from './search'

// Paints the words of a search hit's query in the section its anchor opens, with the browser's highlight and no markup of ours: a hostile query adds nothing to the page, and a swap or hydration meets no new element.
const SECTION_END = 'h1, h2, h3, h4'
const SKIPPED = 'script, style, template, noscript, nav, footer, svg, [data-search="false"]'
const STYLE = `@layer ${ARRIVAL_HIGHLIGHT} { ::highlight(${ARRIVAL_HIGHLIGHT}) { background: Mark; color: MarkText } }`
let styled = false

// Marks the query's words in the section `hash` names, else in the content above the first heading, scrolling to the first when it is out of view and the window is still at `from`; clears the marks of the page before.
export function markArrival(search: string, hash: string = location.hash, from: number = scrollY): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined')
    return

  CSS.highlights.delete(ARRIVAL_HIGHLIGHT)

  if (!arrives(search))
    return

  const terms = searchWords(new URLSearchParams(search).get(ARRIVAL_PARAM) ?? '').filter(term => term.length >= MIN_WORD).slice(0, ARRIVAL_WORDS).map(term => term.slice(0, ARRIVAL_WORD_LENGTH))
  const ranges = terms.length === 0 ? [] : rangesOf(hash, terms)

  if (ranges.length === 0)
    return

  paintStyle()
  CSS.highlights.set(ARRIVAL_HIGHLIGHT, new Highlight(...ranges))

  const first = ranges[0]!.getBoundingClientRect()

  if (scrollY === from && (first.top < 0 || first.bottom > innerHeight))
    ranges[0]!.startContainer.parentElement?.scrollIntoView({ block: 'center' })
}

function paintStyle(): void {
  if (styled || typeof CSSStyleSheet === 'undefined')
    return

  try {
    const sheet = new CSSStyleSheet()

    sheet.replaceSync(STYLE)
    document.adoptedStyleSheets.push(sheet)
    styled = true
  }
  catch {}
}

// The words in the section `hash` names: its heading and the text after it up to the next heading, in document order whatever wraps them; without a hash, what the page holds above its first `h2` to `h4`.
function rangesOf(hash: string, terms: string[]): Range[] {
  let start: Element
  let end: Element | undefined
  let within: Element | undefined

  if (hash === '') {
    start = document.querySelector('main') ?? document.body
    end = start.querySelector('h2, h3, h4') ?? undefined
  }
  else {
    const heading = document.getElementById(fragment(hash))

    if (!heading)
      return []

    start = heading

    if (heading.matches(SECTION_END))
      end = [...document.querySelectorAll(SECTION_END)].find(each => !heading.contains(each) && Boolean(heading.compareDocumentPosition(each) & Node.DOCUMENT_POSITION_FOLLOWING))
    else
      within = heading
  }

  const ranges: Range[] = []
  // From a heading the walk goes on across the page; from a container it stays inside.
  const across = hash !== '' && within === undefined
  const walker = document.createTreeWalker(across ? document.body : start, NodeFilter.SHOW_TEXT)

  if (across)
    walker.currentNode = start

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (end && (end.contains(node) || end.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))
      break

    if (node.parentElement?.closest(SKIPPED))
      continue

    for (const [from, to] of wordHits(node.textContent ?? '', terms)) {
      const range = document.createRange()

      range.setStart(node, from)
      range.setEnd(node, to)
      ranges.push(range)
    }
  }

  return ranges
}

function fragment(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1))
  }
  catch {
    return hash.slice(1)
  }
}
