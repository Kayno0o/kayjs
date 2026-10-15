import type { LocaleSettings } from '../runtime/i18n'
import type { ServedPaths } from '../server/served-paths'
import { localePath } from '../runtime/i18n'

// What `kay check` reads of the content and claims for it, apart from `./server` so it loads no Elysia and no collection.
// Starts the line `kay check` reads the content problems from.
export const PROBLEMS_MARKER = 'kay-content-problems:'
// Starts the line `kay check` reads the components Markdown entries use from.
export const USES_MARKER = 'kay-content-uses:'
// Starts the line `kay check` reads the collections' feeds from, which it claims their paths for as the server does.
export const FEEDS_MARKER = 'kay-content-feeds:'

// A collection's feed, by the collection's name.
export interface CollectionFeed {
  collection: string
  path: string
  localized: boolean
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
