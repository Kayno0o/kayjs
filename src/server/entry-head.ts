import type { Collection } from '../content'
import type { PageContext } from '../runtime/core'
import type { HeadTag } from '../runtime/head'
import type { ServedRoute } from './guards'
import { isCollection } from '../content'
import { entryHead } from '../content/entry-head'
import { FEED_TYPES, feedPaths, resolvedFeed } from '../content/feed'
import { localHref } from '../runtime/html'
import { pagePrerender, pageSetting } from './page-settings'

// The page modules that list no collection and name no feed, which have no entry head on any request.
const headless = new WeakSet<object>()

// The head of a page showing one entry of the collection its `prerender` or `sitemap` lists, written from the entry's data: the collection fills a route of one param with the slugs, so the entry is the one `get()` finds for it.
// With the discovery links of the feeds of that collection and of those the page's `feed` setting names, unless it says `false`. Settled at once when there is no entry to read.
export function entryHeadOf(page: object, route: ServedRoute, ctx: PageContext<Record<string, unknown>>): Promise<HeadTag[] | undefined> | HeadTag[] | undefined {
  if (headless.has(page))
    return undefined

  const listed = pagePrerender(page, route)
  const collection = isCollection(listed) ? listed : pageSetting(page, 'sitemap')
  const setting = pageSetting(page, 'feed')
  const shown = isCollection(collection) ? [collection] : []
  const feeds = setting === false ? [] : [...new Set([...shown, ...[setting].flat().filter(isCollection)])].filter(each => each.options.feed !== undefined)
  const links = feeds.flatMap(feedLinks)

  if (!isCollection(collection) && links.length === 0)
    headless.add(page)

  if (!isCollection(collection) || route.params.length !== 1)
    return links.length > 0 ? links : undefined

  return entryTags(collection, route, ctx, links)
}

async function entryTags(collection: Collection<unknown>, route: ServedRoute, ctx: PageContext<Record<string, unknown>>, links: HeadTag[]): Promise<HeadTag[] | undefined> {
  const slug = ctx.params[route.params[0]!]
  const entry = typeof slug === 'string' ? await collection.get(slug) : undefined
  const tags = entry === undefined ? [] : entryHead(collection, entry)

  return tags.length + links.length > 0 ? [...tags, ...links] : undefined
}

// The `link rel="alternate"` of each format a collection's feed serves, at the path of the page's locale.
function feedLinks(collection: Collection<unknown>): HeadTag[] {
  const feed = resolvedFeed(collection)

  return feedPaths(feed).map(({ format, path }) => ({ tag: 'link', props: { rel: 'alternate', type: FEED_TYPES[format], title: feed.title, href: localHref(path) } }))
}
