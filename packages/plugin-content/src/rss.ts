// RSS 2.0 XML feed generation and ETag matching for @kayjs/content.

import type { Collection, ContentEntry } from './collection'
import { getAppContext } from '@kayjs/kay/internal/server'
import { escAttr } from '@kayjs/kay/server'

export interface RssFeedConfig<TData = Record<string, unknown>> {
  /** Public path for the RSS XML file (default: '/rss.xml'). */
  path?: string | undefined
  title: string
  description: string
  /** Public site origin; defaults to `KayConfig.site` when registered via `content()`. */
  site?: string | undefined
  collection: Collection<TData>
  locale?: string | undefined
  /** URL prefix prepended to each entry's slug (e.g. '/blog'). */
  linkPrefix?: string | undefined
  mapItem?: ((entry: ContentEntry<TData>) => {
    title: string
    description?: string | undefined
    date?: string | Date | undefined
    link?: string | undefined
  }) | undefined
}

export interface ContentFeed {
  readonly path?: string | undefined
  readonly title: string
  readonly description: string
  readonly site?: string | undefined
  readonly collection: Collection<unknown>
  readonly locale?: string | undefined
  readonly linkPrefix?: string | undefined
  readonly mapItem?: ((entry: ContentEntry<never>) => {
    title: string
    description?: string | undefined
    date?: string | Date | undefined
    link?: string | undefined
  }) | undefined
}

export function renderRss<TData>(feed: RssFeedConfig<TData>): string {
  const site = (feed.site ?? getAppContext()?.site ?? '').replace(/\/$/, '')
  const prefix = (feed.linkPrefix ?? '').replace(/\/$/, '')
  const items = feed.collection.all(feed.locale).map((entry) => {
    const rawData = entry.data as Record<string, unknown>
    const mapped = feed.mapItem
      ? feed.mapItem(entry)
      : {
          title: String(rawData.title ?? entry.slug),
          description: typeof rawData.description === 'string' ? rawData.description : undefined,
          date: rawData.date as string | Date | undefined,
          link: `${site}${prefix}/${entry.slug}`,
        }
    const link = mapped.link ?? `${site}${prefix}/${entry.slug}`
    const pubDate = mapped.date ? `<pubDate>${new Date(mapped.date).toUTCString()}</pubDate>` : ''
    const desc = mapped.description ? `<description>${escAttr(mapped.description)}</description>` : ''
    return `<item><title>${escAttr(mapped.title)}</title><link>${escAttr(link)}</link><guid>${escAttr(link)}</guid>${pubDate}${desc}</item>`
  }).join('')

  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<rss version="2.0"><channel>`
    + `<title>${escAttr(feed.title)}</title>`
    + `<link>${escAttr(site)}</link>`
    + `<description>${escAttr(feed.description)}</description>`
    + items
    + `</channel></rss>`
}

export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch)
    return false
  const trimmed = ifNoneMatch.trim()
  if (trimmed === '*')
    return true
  const target = etag.replace(/^W\//, '')
  return trimmed.split(',').some(part => part.trim().replace(/^W\//, '') === target)
}
