import type { TrailingSlash } from '../config'
import type { EntryUrls } from '../content/edit'
import type { LocaleSettings } from '../runtime/i18n'
import type { ServedRoute } from './guards'
import { isCollection } from '../content'
import { importModule } from './bundle'
import { localeCopies } from './i18n'
import { pageSetting } from './page-settings'
import { pathOf } from './prerendered'
import { slashedPath } from './routes'

// An entry's page: the route whose `prerender` lists its collection, its one param the entry's slug, in the entry's locale, under the base; another domain's page whole.
export function entryUrls(routes: ServedRoute[], base: string, trailingSlash?: TrailingSlash, settings?: LocaleSettings): EntryUrls {
  let listing: Promise<Map<string, ServedRoute>> | undefined

  return async (collection, entry) => {
    listing ??= listingRoutes(routes)

    const route = (await listing).get(collection.name)

    if (!route)
      return undefined

    const copies = localeCopies(settings, pathOf(route, { [route.params[0]!]: entry.slug }))
    const copy = copies.find(each => each.locale === (entry.locale ?? settings?.defaultLocale)) ?? copies[0]!
    const path = `${base}${slashedPath(copy.path, trailingSlash)}`

    return copy.host === undefined ? path : `https://${copy.host}${path}`
  }
}

// Each collection's page by its name, the first route listing it when several do.
async function listingRoutes(routes: ServedRoute[]): Promise<Map<string, ServedRoute>> {
  const listed = await Promise.all(routes.map(async route => route.params.length === 1 ? pageSetting(await importModule<object>(route.file), 'prerender') : undefined))
  const listing = new Map<string, ServedRoute>()

  for (const [index, prerender] of listed.entries()) {
    if (isCollection(prerender) && !listing.has(prerender.name))
      listing.set(prerender.name, routes[index]!)
  }

  return listing
}
