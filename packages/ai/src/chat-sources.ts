import type { Source } from './types'

const TAG = /<[^>]*>|[^<]+/g
const CODE_OR_LINK = /^<(\/?)(?:code|pre|a)[\s/>]/i
// A number of one to four digits with no leading zero: `[01]` and `[12345]` stay text.
const CITATION = /\[([1-9]\d{0,3})\]/g
const ATTRIBUTE_UNSAFE = /[&"<]/g
const ENTITIES: Record<string, string> = { '&': '&amp;', '"': '&quot;', '<': '&lt;' }
// A source leads to a page or a file: no `javascript:` and the like, which a hostile page could have named.
const SAFE_HREF = /^(?:https?:\/\/|mailto:|\/(?![/\\])|#)[^\s"'<>`\\]*$/i

// A path of this site or an anchor in the page: `//host` and `/\host` are another site.
const LOCAL_HREF = /^(?:\/(?![/\\])|#)/

// The `rel` of a link that opens in a new tab, and of one that stays in the page.
export const REL_APART = 'nofollow ugc noopener'
export const REL_HERE = 'nofollow ugc'

// Whether a link of a reply or of the sources list opens in a new tab: all do, except a link of this site when the chat's `links` is `here`.
export const opensApart = (href: string, here: boolean) => !(here && LOCAL_HREF.test(href))

// Whether two lists name the same sources, so a stream's next snapshot repeating them leaves the chat's own list alone.
export function sameSources(a: readonly Source[], b: readonly Source[]): boolean {
  return a.length === b.length && a.every((source, index) => source.n === b[index]!.n && source.title === b[index]!.title && source.href === b[index]!.href)
}

export const attribute = (text: string) => text.replace(ATTRIBUTE_UNSAFE, char => ENTITIES[char]!)

// The sources of a stored or streamed reply that are well-formed and lead somewhere safe, one per number.
export function usableSources(sources: unknown): Source[] {
  if (!Array.isArray(sources))
    return []

  const seen = new Set<number>()
  const usable: Source[] = []

  for (const source of sources as unknown[]) {
    if (typeof source !== 'object' || source === null)
      continue

    const { n, title, href } = source as Record<string, unknown>

    if (typeof n !== 'number' || !Number.isInteger(n) || typeof title !== 'string' || typeof href !== 'string' || !SAFE_HREF.test(href) || seen.has(n))
      continue

    seen.add(n)
    usable.push({ n, title, href })
  }

  return usable
}

// A fence line, alone or inside a quote or a list item: the fence, then what follows it.
const FENCE_LINE = /^[ \t>]*(?:(?:[-*+]|\d+[.)])[ \t]+)?[ \t]{0,3}(`{3}|~{3})(.*)$/
const PARAGRAPH_BREAK = /\n[ \t]*\n/
// The tags `markCode` sets around code, the only ones in its escaped text.
const MARKED_CODE = /<\/?code>/g

// The end of the run of `char` starting at `from`.
function runEnd(text: string, from: number, char: string): number {
  let end = from

  while (text[end] === char)
    end++

  return end
}

const code = (text: string) => `<code>${attribute(text)}</code>`

// The text as written, escaped, with its inline code spans in `<code>`: a run of backticks up to the next run of the same length, an unclosed run staying text, and an escaped backtick opening none.
function markSpans(paragraph: string): string {
  const seen = paragraph.replaceAll('\\`', '  ')
  let result = ''
  let at = 0

  while (at < seen.length) {
    const open = seen.indexOf('`', at)

    if (open === -1)
      break

    const end = runEnd(seen, open, '`')
    let close = -1

    for (let next = seen.indexOf('`', end); next !== -1 && close === -1; next = seen.indexOf('`', runEnd(seen, next, '`'))) {
      if (runEnd(seen, next, '`') - next === end - open)
        close = runEnd(seen, next, '`')
    }

    result += close === -1 ? attribute(paragraph.slice(at, end)) : attribute(paragraph.slice(at, open)) + code(paragraph.slice(open, close))
    at = close === -1 ? end : close
  }

  return result + attribute(paragraph.slice(at))
}

// The text as written, escaped, with its fenced blocks and code spans in `<code>`, so `linkSources` passes over them as over the formatted reply's code: a block runs from its fence line to a line of its own fence character at least as long, or to the end of the text, and a span ends with its paragraph.
function markCode(markdown: string): string {
  const blocks: { code: boolean, lines: string[] }[] = []
  let fence: string | undefined

  for (const line of markdown.split('\n')) {
    const found = FENCE_LINE.exec(line)
    const rest = found?.[2] ?? ''
    const extra = found === null ? 0 : runEnd(rest, 0, found[1]![0]!)
    const marker = found === null ? undefined : found[1]! + rest.slice(0, extra)
    const info = rest.slice(extra)
    // A backtick fence takes no backtick in its info string.
    const opens = fence === undefined && marker !== undefined && !(marker[0] === '`' && info.includes('`'))
    const inCode = fence !== undefined || opens
    const last = blocks.at(-1)

    if (last?.code === inCode)
      last.lines.push(line)
    else
      blocks.push({ code: inCode, lines: [line] })

    if (opens)
      fence = marker
    else if (fence !== undefined && marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && info.trim() === '')
      fence = undefined
  }

  return blocks.map(block => block.code ? code(block.lines.join('\n')) : block.lines.join('\n').split(PARAGRAPH_BREAK).map(markSpans).join('\n\n')).join('\n')
}

// The reply as `markdownHtml` writes it until its renderer arrives, its text as written, with each `[n]` outside code linked and the sources cited, as `linkSources` gives them for the formatted reply: fences and spans are set aside as formatting would, so the links and the list rarely change once it is formatted (a citation in link text or an indented block still counts).
export function linkAsWritten(markdown: string, sources: readonly Source[]): { html: string, cited: Source[] } {
  const linked = linkSources(markCode(markdown), sources)

  return { html: `<p>${linked.html.replace(MARKED_CODE, '')}</p>\n`, cited: linked.cited }
}

// The sources a reply cites outside code, read from its markdown as written, for a turn whose renderer is still loading.
export const citedAsWritten = (markdown: string, sources: readonly Source[]) => linkAsWritten(markdown, sources).cited

// The reply's HTML with each `[n]` outside code and links turned into a link to its source, and the sources cited, in the order they were first cited.
export function linkSources(html: string, sources: readonly Source[]): { html: string, cited: Source[] } {
  if (sources.length === 0)
    return { html, cited: [] }

  const byNumber = new Map(sources.map(source => [source.n, source]))
  const cited = new Map<number, Source>()
  let skipping = 0

  const linked = html.replace(TAG, (part) => {
    if (part.startsWith('<')) {
      const tag = CODE_OR_LINK.exec(part)

      if (tag)
        skipping = Math.max(0, skipping + (tag[1] === '/' ? -1 : 1))

      return part
    }

    if (skipping > 0)
      return part

    return part.replace(CITATION, (whole, digits: string) => {
      const source = byNumber.get(Number(digits))

      if (!source)
        return whole

      cited.set(source.n, source)

      return `<a href="${attribute(source.href)}">${whole}</a>`
    })
  })

  return { html: linked, cited: [...cited.values()] }
}
