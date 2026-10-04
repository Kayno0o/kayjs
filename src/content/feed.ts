import type { Entry } from './index'
import { escape as escapeHtml, escapeAttribute as escapeHtmlAttribute } from '../runtime/escape'

export interface FeedItem {
  title: string
  // The entry's page, a path on the site such as `/blog/hello`.
  path: string
  date: Date
  description?: string
  author?: string
}

export interface FeedOptions<Data> {
  // Where the feed is served, such as `/blog/rss.xml`.
  path: string
  title: string
  description?: string
  // Who writes the feed, which Atom requires; its title otherwise.
  author?: string
  // RSS 2.0 by default.
  format?: 'rss' | 'atom'
  // The newest this many items, 20 by default.
  limit?: number
  // What an entry shows as, or undefined to leave it out, such as a draft.
  item: (entry: Entry<Data>) => FeedItem | undefined
}

const DEFAULT_LIMIT = 20
// Characters XML 1.0 refuses anywhere, which a title may still carry.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\v\f\u000E-\u001F\uFFFE\uFFFF]/g

// The feed's XML: its items newest first, every link absolute on the site's origin.
export function feedXml<Data>(entries: Entry<Data>[], options: FeedOptions<Data>, origin: string): string {
  const items = entries.flatMap((entry) => {
    const item = options.item(entry)

    if (item && Number.isNaN(item.date.getTime()))
      throw new Error(`kay: the feed at ${options.path} gives ${entry.file} an invalid date`)

    return item ? [item] : []
  }).sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, options.limit ?? DEFAULT_LIMIT)
  const self = new URL(options.path, origin).href
  const updated = items[0]?.date ?? new Date(0)

  if (options.format === 'atom') {
    return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>${escape(options.title)}</title>${options.description === undefined ? '' : `\n<subtitle>${escape(options.description)}</subtitle>`}
<link href="${escapeAttribute(origin)}/"/>
<link rel="self" href="${escapeAttribute(self)}"/>
<id>${escape(self)}</id>
<updated>${updated.toISOString()}</updated>
<author><name>${escape(options.author ?? options.title)}</name></author>
${items.map((item) => {
  const link = new URL(item.path, origin).href

  return `<entry><title>${escape(item.title)}</title><link href="${escapeAttribute(link)}"/><id>${escape(link)}</id><updated>${item.date.toISOString()}</updated>${item.description === undefined ? '' : `<summary>${escape(item.description)}</summary>`}${item.author === undefined ? '' : `<author><name>${escape(item.author)}</name></author>`}</entry>`
}).join('\n')}
</feed>
`
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${escape(options.title)}</title>
<link>${escape(origin)}/</link>
<description>${escape(options.description ?? options.title)}</description>
<atom:link href="${escapeAttribute(self)}" rel="self" type="application/rss+xml"/>
<lastBuildDate>${updated.toUTCString()}</lastBuildDate>
${items.map((item) => {
  const link = new URL(item.path, origin).href

  return `<item><title>${escape(item.title)}</title><link>${escape(link)}</link><guid>${escape(link)}</guid><pubDate>${item.date.toUTCString()}</pubDate>${item.description === undefined ? '' : `<description>${escape(item.description)}</description>`}${item.author === undefined ? '' : `<dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">${escape(item.author)}</dc:creator>`}</item>`
}).join('\n')}
</channel>
</rss>
`
}

function escape(text: string): string {
  return escapeHtml(text.replace(INVALID_XML, ''))
}

function escapeAttribute(text: string): string {
  return escapeHtmlAttribute(text.replace(INVALID_XML, ''))
}
