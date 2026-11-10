import type { Segment } from './markdown'
import { decode } from './markdown'

// The marker an author writes between the lead and the rest of an entry, as Markdown passes it through.
const MORE = /<!--\s*more\s*-->/i
const PARAGRAPH = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g
const TAGS = /<[^>]*>/g
const SPACES = /\s+/g
const TRAILING_PUNCTUATION = /[\s,;:.!?-]+$/
// What a description keeps of an excerpt: a search result shows about this much.
const DESCRIPTION_LENGTH = 160

function plain(markup: string): string {
  return decode(markup.replace(TAGS, '')).replace(SPACES, ' ').trim()
}

// The text of an entry's lead: its paragraphs before a `<!-- more -->` marker, else its first paragraph; empty for a body with none. A marker inside code is escaped by the renderer, so only a real one counts, and a loader's untrusted body has its comments removed before this, leaving the first paragraph.
// Only the Markdown's own paragraphs count: what a component renders, or a paragraph inside one, is not there.
export function excerptOf(segments: readonly Segment[]): string {
  const markup = segments.filter((segment): segment is string => typeof segment === 'string').join('')
  const marker = MORE.exec(markup)
  const lead = marker === null ? markup : markup.slice(0, marker.index)
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
