import type { TrailingSlash } from '../config'
import type { Html } from '../runtime/rendered'
import type { Collection, Entry } from './index'
import { KayError } from '../compiler/errors'
import { escape as escapeHtml, escapeAttribute as escapeHtmlAttribute } from '../runtime/escape'
import { exportNameOf } from '../runtime/fields'
import { slashedPath } from '../server/routes'
import { dataOf, entryModified, entryPublished, text } from './entry-head'
import { humanize } from './validate'

export interface FeedItem {
  title: string
  // The entry's page, a path on the site such as `/blog/hello`; the entry's `url` when the collection has a `route` and this is left out.
  path?: string | undefined
  date: Date
  // When the entry last changed, `date` when left out.
  updated?: Date | undefined
  description?: string | undefined
  author?: string | undefined
  // The entry's body as HTML, the links in it left as the page writes them; the rendered body of the entry when the feed sets `content: true` and this is left out.
  content?: string | undefined
  categories?: string[] | undefined
  // A picture for the item, a path on the site or an absolute URL.
  image?: string | undefined
}

export type FeedFormat = 'rss' | 'atom' | 'json'

// A collection with no `route` must say where each item links.
export type FeedItemOf<Routed extends boolean> = Routed extends false ? FeedItem & { path: string } : FeedItem

export interface FeedOptions<Data, Routed extends boolean = boolean> {
  // Where the feed is served, such as `/blog/rss.xml`; with several formats, the first one is served here and each other at this path with its extension replaced by the format's, `/blog/rss.json`.
  path: string
  // The collection's `title`, else its name humanized, when left out.
  title?: string | undefined
  description?: string | undefined
  // Who writes the feed, which Atom requires; its title otherwise.
  author?: string | undefined
  // RSS 2.0 by default; a list serves each of them from the one collection.
  format?: FeedFormat | readonly FeedFormat[] | undefined
  // The newest this many items, 20 by default.
  limit?: number | undefined
  // Carries each item's whole body as HTML, `content:encoded` in RSS, `content` in Atom and `content_html` in JSON.
  content?: boolean | undefined
  // What an entry shows as, or undefined to leave it out, such as a draft; by default its `title`, `description`, `author`, `tags` and `image` fields, dated by the collection's `publishAt` else `date`, `publishedAt` or `published`, and linked to its `url`.
  item?: ((entry: Entry<Data>) => FeedItemOf<Routed> | undefined) | undefined
}

const DEFAULT_LIMIT = 20
// Characters XML 1.0 refuses anywhere, which a title may still carry.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\v\f\u000E-\u001F\uFFFE\uFFFF]/g
const EXTENSION = /\.[^./]*$/
const QUERY_OR_FRAGMENT = /[?#]/
const ROOT_PATH_ATTRIBUTE = /(\s(?:href|src)=")\/(?!\/)/g
const IMAGE_TYPES: Record<string, string> = { avif: 'image/avif', gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp' }

export const FEED_TYPES: Record<FeedFormat, string> = { rss: 'application/rss+xml', atom: 'application/atom+xml', json: 'application/feed+json' }

// The formats a feed serves, the first at its `path` and each other beside it.
export function feedPaths(feed: Pick<FeedOptions<unknown>, 'path' | 'format'>): { format: FeedFormat, path: string }[] {
  const formats = [...new Set([feed.format ?? 'rss'].flat())]

  return formats.map((format, index) => ({ format, path: index === 0 ? feed.path : `${feed.path.replace(EXTENSION, '')}.${format}` }))
}

// The collection's feed with what it implies filled in: its title, and the items of the common fields of the data.
export function resolvedFeed(collection: Collection<unknown>): FeedOptions<unknown> & { title: string } {
  const feed = collection.options.feed!

  return { ...feed, title: feed.title ?? collection.options.title ?? humanize(exportNameOf(collection.name)), item: feed.item ?? defaultFeedItem(collection) }
}

// What the feed shows an entry as when the collection's `item` is left out: the common fields of its data.
export function defaultFeedItem(collection?: { options: { publishAt?: string | undefined, modified?: string | undefined } }): (entry: Entry<unknown>) => FeedItem {
  const dates = collection ?? { options: {} }

  return (entry) => {
    const data = dataOf(entry)
    const title = text(data.title)
    const date = entryPublished(dates, entry)

    if (title === undefined || date === undefined)
      throw new KayError('content-invalid', `kay: the feed gives ${entry.file} no ${title === undefined ? '`title`' : 'date'}; give its data a ${title === undefined ? '`title`' : '`date`'} field, or set \`item\` in the feed`)

    const tags = [data.tags, data.categories].find(Array.isArray)
    const categories = tags?.filter((tag): tag is string => typeof tag === 'string')

    return { title, date, ...entryModified(dates, entry) && { updated: entryModified(dates, entry) }, description: text(data.description), author: text(data.author), ...categories && categories.length > 0 && { categories }, image: text(data.image) ?? text(data.cover) }
  }
}

// What the feed shows an entry as, its page the `item`'s `path` or else the entry's `url`.
export function feedItem<Data>(options: FeedOptions<Data, boolean>, entry: Entry<Data>): (FeedItem & { path: string }) | undefined {
  const item = options.item ? options.item(entry) : defaultFeedItem()(entry)

  if (!item)
    return undefined

  const path = item.path ?? entry.url

  if (path === undefined)
    throw new KayError('content-invalid', `kay: the feed at ${options.path} gives ${entry.file} no \`path\`; set it in \`item\`, or give the collection a \`route\``)

  return { ...item, path }
}

// The body of an entry as HTML, the links and images that start at the site's root written out in full on the origin, its mount point included, as the page adds the base on its way out.
function bodyOf(entry: Entry<unknown>, origin: string): string {
  const rendered = (entry.Content as () => Html)()

  if (typeof (rendered as Partial<Html>).t !== 'string')
    throw new KayError('content-invalid', `kay: the feed cannot carry ${entry.file}'s body, whose content does not render at once`)

  return rendered.t.replace(ROOT_PATH_ATTRIBUTE, `$1${origin}/`)
}

interface Shown {
  item: FeedItem & { path: string }
  link: string
  image: string | undefined
  content: string | undefined
}

// The feed's document in one format: its items newest first, every link absolute on the site's origin and written as `trailingSlash` writes a page's canonical URL, the site's own at `home`, its locale's home page for a localized feed.
export function feedDocument<Data>(format: FeedFormat, entries: Entry<Data>[], options: FeedOptions<Data>, origin: string, home = '/', trailingSlash?: TrailingSlash, path = options.path): string {
  const title = options.title ?? options.path

  const shown: Shown[] = entries.flatMap((entry) => {
    const item = feedItem(options, entry)

    if (item && Number.isNaN(item.date.getTime()))
      throw new KayError('content-invalid', `kay: the feed at ${options.path} gives ${entry.file} an invalid date`)

    return item ? [{ item, entry }] : []
  }).sort((a, b) => b.item.date.getTime() - a.item.date.getTime()).slice(0, options.limit ?? DEFAULT_LIMIT).map(({ item, entry }) => ({
    item,
    // Joined rather than resolved, so an origin carrying the site's mount point keeps it.
    link: origin + slashedPath(item.path, trailingSlash),
    image: item.image !== undefined && item.image.startsWith('/') && !item.image.startsWith('//') ? origin + item.image : item.image,
    content: item.content ?? (options.content === true ? bodyOf(entry, origin) : undefined),
  }))

  const self = origin + path
  const updated = shown.reduce((latest, { item }) => new Date(Math.max(latest.getTime(), (item.updated ?? item.date).getTime())), new Date(0))
  const homeUrl = origin + slashedPath(home, trailingSlash)

  if (format === 'json')
    return jsonFeed(shown, { title, description: options.description, author: options.author, home: homeUrl, self })

  if (format === 'atom') {
    return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>${escape(title)}</title>${options.description === undefined ? '' : `\n<subtitle>${escape(options.description)}</subtitle>`}
<link href="${escapeAttribute(homeUrl)}"/>
<link rel="self" href="${escapeAttribute(self)}"/>
<id>${escape(self)}</id>
<updated>${updated.toISOString()}</updated>
<author><name>${escape(options.author ?? title)}</name></author>
${shown.map(({ item, link, image, content }) => `<entry><title>${escape(item.title)}</title><link href="${escapeAttribute(link)}"/><id>${escape(link)}</id><updated>${(item.updated ?? item.date).toISOString()}</updated>${item.updated === undefined ? '' : `<published>${item.date.toISOString()}</published>`}${item.description === undefined ? '' : `<summary>${escape(item.description)}</summary>`}${content === undefined ? '' : `<content type="html">${escape(content)}</content>`}${item.author === undefined ? '' : `<author><name>${escape(item.author)}</name></author>`}${(item.categories ?? []).map(category => `<category term="${escapeAttribute(category)}"/>`).join('')}${image === undefined ? '' : `<link rel="enclosure" type="${imageType(image)}" href="${escapeAttribute(image)}"/>`}</entry>`).join('\n')}
</feed>
`
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
<title>${escape(title)}</title>
<link>${escape(homeUrl)}</link>
<description>${escape(options.description ?? title)}</description>
<atom:link href="${escapeAttribute(self)}" rel="self" type="application/rss+xml"/>
<lastBuildDate>${updated.toUTCString()}</lastBuildDate>
${shown.map(({ item, link, image, content }) => `<item><title>${escape(item.title)}</title><link>${escape(link)}</link><guid>${escape(link)}</guid><pubDate>${item.date.toUTCString()}</pubDate>${item.description === undefined ? '' : `<description>${escape(item.description)}</description>`}${content === undefined ? '' : `<content:encoded>${cdata(content)}</content:encoded>`}${item.author === undefined ? '' : `<dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">${escape(item.author)}</dc:creator>`}${(item.categories ?? []).map(category => `<category>${escape(category)}</category>`).join('')}${image === undefined ? '' : `<enclosure url="${escapeAttribute(image)}" length="0" type="${imageType(image)}"/>`}</item>`).join('\n')}
</channel>
</rss>
`
}

// The feed's XML in the first format its `format` names, RSS 2.0 by default.
export function feedXml<Data>(entries: Entry<Data>[], options: FeedOptions<Data>, origin: string, home = '/', trailingSlash?: TrailingSlash): string {
  return feedDocument(feedPaths(options)[0]!.format, entries, options, origin, home, trailingSlash)
}

// JSON Feed 1.1.
function jsonFeed(shown: Shown[], feed: { title: string, description: string | undefined, author: string | undefined, home: string, self: string }): string {
  return `${JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: feed.title,
    home_page_url: feed.home,
    feed_url: feed.self,
    ...feed.description !== undefined && { description: feed.description },
    ...feed.author !== undefined && { authors: [{ name: feed.author }] },
    items: shown.map(({ item, link, image, content }) => ({
      id: link,
      url: link,
      title: item.title,
      ...content === undefined ? { content_text: item.description ?? item.title } : { content_html: content },
      ...item.description !== undefined && { summary: item.description },
      date_published: item.date.toISOString(),
      ...item.updated !== undefined && { date_modified: item.updated.toISOString() },
      ...item.author !== undefined && { authors: [{ name: item.author }] },
      ...item.categories && item.categories.length > 0 && { tags: item.categories },
      ...image !== undefined && { image },
    })),
  }, undefined, 2)}\n`
}

function imageType(url: string): string {
  return IMAGE_TYPES[url.split(QUERY_OR_FRAGMENT)[0]!.split('.').pop()!.toLowerCase()] ?? 'image/jpeg'
}

// Character data, a `]]>` inside it split across two sections.
function cdata(text: string): string {
  return `<![CDATA[${text.replace(INVALID_XML, '').replaceAll(']]>', ']]]]><![CDATA[>')}]]>`
}

function escape(text: string): string {
  return escapeHtml(text.replace(INVALID_XML, ''))
}

function escapeAttribute(text: string): string {
  return escapeHtmlAttribute(text.replace(INVALID_XML, ''))
}
