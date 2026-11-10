import type { Segment } from './markdown'
import { decode } from './markdown'

// The marker an author writes between the lead and the rest of an entry, as Markdown passes it through.
const MORE = /<!--\s*more\s*-->/i
const MORE_EVERYWHERE = new RegExp(MORE.source, 'gi')
const PARAGRAPH = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g
// Paragraphs a quote, a list item or a disclosure holds, however deep, are not the entry's own lead.
const CONTAINER = /<(\/?)(?:blockquote|li|details)\b[^>]*>/g
const TAGS = /<[^>]*>/g
const SPACES = /\s+/g
const TRAILING_PUNCTUATION = /[\s,;:.!?-]+$/
// What a description keeps of an excerpt: a search result shows about this much.
const DESCRIPTION_LENGTH = 160

// The markup with whatever sits inside a quote, a list item or a disclosure taken out, nested ones counted.
function withoutContainers(markup: string): string {
  let kept = ''
  let depth = 0
  let from = 0

  for (const tag of markup.matchAll(CONTAINER)) {
    if (depth === 0)
      kept += markup.slice(from, tag.index)

    depth = Math.max(0, depth + (tag[1] === '/' ? -1 : 1))
    from = tag.index + tag[0].length
  }

  return depth === 0 ? kept + markup.slice(from) : kept
}

function plain(markup: string): string {
  return decode(markup.replace(TAGS, '')).replace(SPACES, ' ').trim()
}

// The text of an entry's lead: its paragraphs before a `<!-- more -->` marker, else its first paragraph; empty for a body with none. A marker inside code is escaped by the renderer, so only a real one counts.
// Only the Markdown's own paragraphs count: what a component renders, or a paragraph inside one, is not there.
export function excerptOf(segments: readonly Segment[]): string {
  const markup = segments.filter((segment): segment is string => typeof segment === 'string').join('')
  const marker = MORE.exec(markup)
  const lead = withoutContainers(marker === null ? markup : markup.slice(0, marker.index))
  const paragraphs = [...lead.matchAll(PARAGRAPH)].map(match => plain(match[1]!)).filter(paragraph => paragraph !== '')

  return (marker === null ? paragraphs.slice(0, 1) : paragraphs).join(' ')
}

// An excerpt as a meta description: whole, or cut at a word under 160 characters and closed with an ellipsis.
export function descriptionOf(excerpt: string): string | undefined {
  if (excerpt === '')
    return undefined

  if (excerpt.length <= DESCRIPTION_LENGTH)
    return excerpt

  const cut = excerpt.slice(0, DESCRIPTION_LENGTH - 1)
  const space = cut.lastIndexOf(' ')

  return `${(space > 0 ? cut.slice(0, space) : cut).replace(TRAILING_PUNCTUATION, '')}…`
}

// A sanitizer removes comments, so a loader's untrusted body would lose its marker before the excerpt is read: the marker goes through it as a paragraph of this text, and comes back as the comment.
const KEPT_MARKER = 'kay-more-marker-7f3a'
const MARKER_LINE = /^[ \t]{0,3}<!--\s*more\s*-->[ \t]*$/
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/
const KEPT_PARAGRAPH = new RegExp(`<p>${KEPT_MARKER}</p>\\n?`, 'g')

// The Markdown with each marker on a line of its own, outside a code fence, written as the paragraph that survives a sanitizer; the line count stays, so a component's error keeps its line.
export function keepMarker(markdown: string): string {
  let fence: string | undefined

  return markdown.split('\n').map((line) => {
    const opened = FENCE.exec(line)?.[1]

    if (fence === undefined) {
      fence = opened

      return fence === undefined && MARKER_LINE.test(line) ? KEPT_MARKER : line
    }

    if (opened !== undefined && opened[0] === fence[0] && opened.length >= fence.length && line.trim() === opened)
      fence = undefined

    return line
  }).join('\n')
}

// The HTML with each comment marker written as the paragraph that survives a sanitizer.
export function keepMarkerHtml(markup: string): string {
  return markup.replace(MORE_EVERYWHERE, `<p>${KEPT_MARKER}</p>`)
}

// The sanitized HTML with its kept markers written as the comment again.
export function restoreMarker(markup: string): string {
  return markup.replace(KEPT_PARAGRAPH, '<!-- more -->\n').replaceAll(KEPT_MARKER, '')
}
