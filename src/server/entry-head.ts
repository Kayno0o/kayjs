import type { PageContext } from '../runtime/core'
import type { HeadTag } from '../runtime/head'
import type { ServedRoute } from './guards'
import { isCollection } from '../content'
import { entryHead } from '../content/entry-head'
import { pageSetting } from './page-settings'

// The head of a page showing one entry of the collection its `prerender` or `sitemap` lists, written from the entry's data: the collection fills a route of one param with the slugs, so the entry is the one `get()` finds for it.
export async function entryHeadOf(page: object, route: ServedRoute, ctx: PageContext<Record<string, unknown>>): Promise<HeadTag[] | undefined> {
  const listed = pageSetting(page, 'prerender')
  const collection = isCollection(listed) ? listed : pageSetting(page, 'sitemap')

  if (!isCollection(collection) || route.params.length !== 1)
    return undefined

  const slug = ctx.params[route.params[0]!]
  const entry = typeof slug === 'string' ? await collection.get(slug) : undefined

  return entry === undefined ? undefined : entryHead(collection, entry)
}
