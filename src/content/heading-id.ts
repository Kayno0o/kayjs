import type { Heading } from './markdown'

const NON_ASCII = /\P{ASCII}/u
const SEPARATORS = /[^\p{L}\p{N}\p{M}]+/gu
const UNDERSCORES = /_/g
const EDGES = /^-+|-+$/g
const ALPHANUMERIC = /[\p{L}\p{N}]/u

// The id of a heading from its text and the one Bun gave it: Bun's own for a title of ASCII, which keeps the anchors already shared, else the title's letters and digits in any script, lowercased and joined by `-`. Never empty.
function headingId(text: string, given: string): string {
  const own = NON_ASCII.test(text) ? text.normalize('NFC').toLowerCase().replace(UNDERSCORES, '').replace(SEPARATORS, '-').replace(EDGES, '') : given

  // A title with no letter or digit has no id of Bun's worth keeping: it numbers such ids from an empty one, `-2`.
  return own === '' || !ALPHANUMERIC.test(text) ? 'heading' : own
}

// The id, or the first of `id-1`, `id-2`... the page does not hold yet; Bun numbers only a title it has seen twice, so `A 1` after two `A` would repeat `a-1`.
function uniqueHeadingId(id: string, used: Set<string>): string {
  let result = id

  for (let n = 1; used.has(result); n++)
    result = `${id}-${n}`

  used.add(result)

  return result
}

// The page's headings, each with the id `headingId` gives it, unique in the page, written into the `html` they were found in, with the anchor link around its text or without; `found` are the elements of its headings in order.
export function numberedHeadings(html: string, found: Iterable<{ open: RegExpExecArray, inner: string, end: number }>, links: boolean, textOf: (inner: string) => string): { html: string, headings: Heading[] } {
  const used = new Set<string>()
  const headings: Heading[] = []
  let rewritten = ''
  let last = 0

  for (const { open, inner, end } of found) {
    const [, depth, given] = open
    const text = textOf(inner)
    const id = uniqueHeadingId(headingId(text, given!), used)

    headings.push({ depth: Number(depth), id, text })
    rewritten += `${html.slice(last, open.index)}<h${depth} id="${id}">${links ? `<a href="#${id}">${inner}</a>` : inner}</h${depth}>`
    last = end
  }

  return { html: rewritten + html.slice(last), headings }
}
