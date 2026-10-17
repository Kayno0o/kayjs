import { ARRIVAL_HIGHLIGHT, ARRIVAL_PARAM, arrives } from './arrival'
import { searchWords, wordHits } from './search'

// Paints the words of a search hit's query in the section its anchor opens, with the browser's highlight and no markup of ours: a hostile query adds nothing to the page, and a swap or hydration meets no new element.
const SECTION_END = 'h1, h2, h3, h4'
const SKIPPED = 'script, style, template, noscript, nav, footer, svg, [data-search="false"]'
const STYLE = `@layer ${ARRIVAL_HIGHLIGHT} { ::highlight(${ARRIVAL_HIGHLIGHT}) { background: Mark; color: MarkText } }`
let styled = false

// Marks the query's words in the section `hash` names, else in the content above the first heading, scrolling to the first; clears the marks of the page before.
export function markArrival(search: string, hash: string = location.hash): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined')
    return

  CSS.highlights.delete(ARRIVAL_HIGHLIGHT)

  if (!arrives(search))
    return

  const terms = searchWords(new URLSearchParams(search).get(ARRIVAL_PARAM) ?? '')
  const parts = hash === '' ? undefined : sectionAt(hash)
  const ranges = terms.length === 0 || parts === null ? [] : [...parts ?? abovePageHeadings()].flatMap(part => rangesIn(part, terms))

  if (ranges.length === 0)
    return

  paintStyle()
  CSS.highlights.set(ARRIVAL_HIGHLIGHT, new Highlight(...ranges))
  ranges[0]!.startContainer.parentElement?.scrollIntoView({ block: 'nearest' })
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

// The heading `hash` points at and what follows it up to the next heading; null when nothing has that id.
function sectionAt(hash: string): Element[] | null {
  let id = hash.slice(1)

  try {
    id = decodeURIComponent(id)
  }
  catch {}

  const heading = document.getElementById(id)

  if (!heading)
    return null

  const section: Element[] = [heading]

  if (!heading.matches(SECTION_END))
    return section

  for (let next = heading.nextElementSibling; next && !next.matches(SECTION_END) && !next.querySelector(SECTION_END); next = next.nextElementSibling)
    section.push(next)

  return section
}

// What a page holds above its first `h2` to `h4`, or all of it without one.
function abovePageHeadings(): Element[] {
  const container = document.querySelector('main') ?? document.body
  const above: Element[] = []

  for (const child of container.children) {
    if (child.matches('h2, h3, h4') || child.querySelector('h2, h3, h4'))
      break

    above.push(child)
  }

  return above
}

function rangesIn(part: Element, terms: string[]): Range[] {
  if (part.closest(SKIPPED))
    return []

  const ranges: Range[] = []
  const walker = document.createTreeWalker(part, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest(SKIPPED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT })

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const [start, end] of wordHits(node.textContent ?? '', terms)) {
      const range = document.createRange()

      range.setStart(node, start)
      range.setEnd(node, end)
      ranges.push(range)
    }
  }

  return ranges
}
