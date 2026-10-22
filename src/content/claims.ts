import type { LocaleSettings } from '../runtime/i18n'
import type { ServedPaths } from '../server/served-paths'
import { localePath } from '../runtime/i18n'
import { routerKey } from '../server/routes'

// What `kay check` reads of the content and claims for it, apart from `./server` so it loads no Elysia and no collection.
// Starts the line `kay check` reads the content problems from.
export const PROBLEMS_MARKER = 'kay-content-problems:'
// Starts the line `kay check` reads the components Markdown entries use from.
export const USES_MARKER = 'kay-content-uses:'
// Starts the line `kay check` reads the collections' feeds from, which it claims their paths for as the server does.
export const FEEDS_MARKER = 'kay-content-feeds:'

// Starts the line `kay check` reads the collections' routes from, which it looks for a page serving.
export const ROUTES_MARKER = 'kay-content-routes:'

// Starts the line `kay check` reads the problems the extensions' `check` found from.
export const EXTENSIONS_MARKER = 'kay-extension-problems:'

// A collection's feed, by the collection's name.
export interface CollectionFeed {
  collection: string
  path: string
  localized: boolean
}

const CATCH_ALL = /\*[^/]+/

// A collection's route, by the collection's name.
export interface CollectionRoute {
  collection: string
  route: string
}

// The routes no page's pattern serves, `/blog/:slug` by the page `blog/[slug].kay` and `/docs/*slug` by `docs/[...slug].kay`.
export function unservedRoutes(routes: CollectionRoute[], patterns: string[]): CollectionRoute[] {
  const served = new Set(patterns.map(routerKey))
  // A catch-all page serves every path under its folder.
  const folders = [...served].filter(pattern => pattern.endsWith('*')).map(pattern => pattern.slice(0, -1))

  return routes.filter(({ route }) => {
    const key = routerKey(route.replace(CATCH_ALL, '*'))

    return !served.has(key) && !folders.some(folder => key.startsWith(folder))
  })
}

// Claims where a collection's feed is served: at its path, or a localized collection's under each locale's prefix, the locale then known; with domains, each host serves its own at the path.
export function claimFeed(served: ServedPaths, feed: CollectionFeed, settings: LocaleSettings | undefined): { path: string, locale: string | undefined }[] {
  // A feed is no page, so no translated path names it.
  const paths = !feed.localized || !settings || settings.hosts
    ? [{ path: feed.path, locale: undefined }]
    : settings.locales.map(locale => ({ path: localePath({ ...settings, paths: undefined }, feed.path, locale), locale }))

  for (const { path } of paths)
    served.claim({ path, owner: `the feed of the collection ${feed.collection}`, kind: 'kay', exported: true })

  return paths
}
