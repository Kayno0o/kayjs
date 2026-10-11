import type { Elysia } from 'elysia'
import type { LocaleSettings } from '../runtime/i18n'
import type { I18n } from '../server/i18n'
import type { ServedPaths } from '../server/served-paths'
import type { Collection } from './index'
import type { Segment } from './markdown'
import type { ContentProblem } from './validate'
import { dirname, relative } from 'node:path'
import { projectPaths } from '../project'
import { nameCollection } from '../runtime/fields'
import { localePath } from '../runtime/i18n'
import { runInLocale } from '../runtime/locale-state'
import { importModule } from '../server/bundle'
import { hostLocale, stateFor } from '../server/i18n'
import { projectSource } from '../server/source'
import { feedXml } from './feed'
import { isCollection } from './index'
import { loadEntries, manifestFile, setContentPlace } from './load'
import { ContentError, decodeEntries } from './validate'

// The module declaring a project's collections, which `kay build`, `kay check` and the server read them from.
const TRAILING_SLASH = /\/$/

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

// A component a Markdown entry writes, with the props it gives, for `kay check` to type them.
export interface ComponentUse {
  // The export naming its collection in the content config.
  collection: string
  component: string
  props: Record<string, unknown>
  children: boolean
  // Relative to the project root.
  file: string
  line: number
}

// The collections the project's content config exports, or none without the default one; their folders are relative to it.
export async function projectCollections(root: string, config?: string): Promise<Collection<unknown>[]> {
  return (await namedCollections(root, config)).map(([, collection]) => collection)
}

// The collections by the name the content config exports each under.
async function namedCollections(root: string, config?: string): Promise<[string, Collection<unknown>][]> {
  const file = projectPaths(root, { content: config }).content

  setContentPlace(root, dirname(file))

  const source = projectSource()

  if (!source.has(file)) {
    if (config !== undefined && !source.embedded)
      throw new Error(`kay: kay.config.ts names ${config} as the content config, and there is no such file`)

    return []
  }

  // Its components are `.kay` files.
  await source.prepare(root)

  const module = await importModule<Record<string, unknown>>(file)

  const collections = Object.entries(module).filter((entry): entry is [string, Collection<unknown>] => isCollection(entry[1]))

  for (const [exported, collection] of collections)
    nameCollection(collection.name, exported)

  return collections
}

// Compiles every collection from its files and writes what the server reads in production, failing on the first collection with a bad entry. A loader's collection is read when the server runs.
export async function writeContentManifests(root: string, clientBase: string, config?: string): Promise<number> {
  let count = 0

  for (const collection of await projectCollections(root, config)) {
    if (collection.dir === undefined)
      continue

    const entries = await loadEntries(collection.dir, collection.options.highlight, true)

    decodeEntries(entries, collection.options.schema, collection.options.components ?? {}, collection.options.localized)
    await Bun.write(manifestFile(clientBase, collection.dir), JSON.stringify(entries))
    count += entries.length
  }

  return count
}

// Every entry that fails to compile or to match its schema, across the project's collections, and the components their Markdown uses, for `kay check`. A loader's entries are read only when the server runs.
// `site` says whether the config sets the site's URL, which a collection's feed needs.
export async function contentProblems(root: string, config?: string, site = true): Promise<{ problems: ContentProblem[], uses: ComponentUse[], feeds: CollectionFeed[] }> {
  const problems: ContentProblem[] = []
  const uses: ComponentUse[] = []
  const feeds: CollectionFeed[] = []

  for (const [name, collection] of await namedCollections(root, config)) {
    if (collection.options.feed)
      feeds.push(collectionFeed(collection))

    if (collection.options.feed && !site)
      problems.push({ file: relative(root, projectPaths(root, { content: config }).content), line: 1, message: feedNeedsSite(collection).message })

    if (collection.dir === undefined)
      continue

    try {
      const entries = await loadEntries(collection.dir, collection.options.highlight, true)

      for (const entry of entries)
        uses.push(...componentUses(name, collection.components, entry.file, entry.segments ?? []))

      decodeEntries(entries, collection.options.schema, collection.options.components ?? {}, collection.options.localized)
    }
    catch (error) {
      if (!(error instanceof ContentError))
        throw error

      problems.push(...error.problems)
    }
  }

  return { problems, uses, feeds }
}

// A component the collection lacks is a content problem of its own, so only those it has are typed.
function componentUses(collection: string, components: object, file: string, segments: Segment[]): ComponentUse[] {
  return segments.flatMap(segment => typeof segment === 'string' || !Object.hasOwn(components, segment.component)
    ? []
    : [{ collection, component: segment.component, props: segment.props, children: segment.children.length > 0, file, line: segment.line }, ...componentUses(collection, components, file, segment.children)])
}

function feedNeedsSite(collection: Collection<unknown>): Error {
  return new Error(`kay: the collection ${collection.name} has a feed, whose links need the site's URL: set \`site\` in kay.config.ts`)
}

function collectionFeed(collection: Collection<unknown>): CollectionFeed {
  return { collection: collection.name, path: collection.options.feed!.path, localized: collection.options.localized === true }
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

// Serves each collection's feed at its path; one stays cached for an hour in production.
// A localized collection's feed lists only the entries written in its locale, linking each at its path there.
export function serveFeeds(app: Elysia, served: ServedPaths, collections: Collection<unknown>[], origin: string | undefined, dev = false, i18n?: I18n): void {
  for (const collection of collections) {
    const { feed } = collection.options

    if (!feed)
      continue

    if (origin === undefined)
      throw feedNeedsSite(collection)

    const headers = { 'content-type': `${feed.format === 'atom' ? 'application/atom+xml' : 'application/rss+xml'}; charset=utf-8`, 'cache-control': dev ? 'no-cache' : 'public, max-age=3600' }

    for (const { path, locale } of claimFeed(served, collectionFeed(collection), i18n?.settings)) {
      app.get(path, async ({ request }) => {
        if (!i18n || collection.options.localized !== true)
          return new Response(feedXml(await collection.all(), feed, origin), { headers })

        const { settings } = i18n
        const written = locale ?? hostLocale(settings, request)
        const host = settings.hosts?.[written]

        return runInLocale(stateFor(i18n, written, feed.path, request), async () => {
          const entries = (await collection.all(written)).filter(entry => entry.locale === written)
          const localized = { ...feed, path, item: (entry: Parameters<typeof feed.item>[0]) => {
            const item = feed.item(entry)

            return item && { ...item, path: localePath(settings, item.path, written, host) }
          } }

          return new Response(feedXml(entries, localized, host === undefined ? origin : onHost(origin, host), localePath(settings, '/', written, host)), { headers })
        })
      })
    }
  }
}

// The site's origin, its mount point kept, on another host.
function onHost(origin: string, host: string): string {
  const url = new URL(origin)

  url.host = host

  return url.href.replace(TRAILING_SLASH, '')
}
