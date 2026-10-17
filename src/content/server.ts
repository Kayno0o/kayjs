import type { Elysia } from 'elysia'
import type { TrailingSlash } from '../config'
import type { I18n } from '../server/i18n'
import type { ServedPaths } from '../server/served-paths'
import type { CollectionFeed } from './claims'
import type { Collection } from './index'
import type { Segment } from './markdown'
import type { ContentProblem } from './validate'
import { dirname, relative, resolve } from 'node:path'
import { KayError } from '../compiler/errors'
import { projectPaths } from '../project'
import { TRAILING_SLASH } from '../runtime/base'
import { nameCollection } from '../runtime/fields'
import { localePath } from '../runtime/i18n'
import { runInLocale } from '../runtime/locale-state'
import { importModule } from '../server/bundle'
import { hostLocale, stateFor } from '../server/i18n'
import { projectSource } from '../server/source'
import { claimFeed } from './claims'
import { entries, registerCollections } from './edit'
import { feedXml } from './feed'
import { isCollection } from './index'
import { loadEntries, manifestFile, markdownOf, pruneContentCache, setContentPlace } from './load'
import { ContentError, decodeEntries } from './validate'

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
export async function namedCollections(root: string, config?: string): Promise<[string, Collection<unknown>][]> {
  const file = projectPaths(root, { content: config }).content

  setContentPlace(root, dirname(file), file)

  const source = projectSource()

  if (!source.has(file)) {
    if (config !== undefined && !source.embedded)
      throw new KayError('content-config-missing', `kay: kay.config.ts names ${config} as the content config, and there is no such file`)

    return []
  }

  // Its components are `.kay` files.
  await source.prepare(root)

  const module = await importModule<Record<string, unknown>>(file)

  const collections = Object.entries(module).filter((entry): entry is [string, Collection<unknown>] => isCollection(entry[1]))

  for (const [exported, collection] of collections)
    nameCollection(collection.name, exported)

  registerCollections(collections)

  return collections
}

// Compiles every collection from its files and writes what the server reads in production, failing on the first collection with a bad entry. A loader's collection is read when the server runs.
export async function writeContentManifests(root: string, clientBase: string, config?: string): Promise<number> {
  let count = 0

  for (const collection of await projectCollections(root, config)) {
    if (collection.dir === undefined)
      continue

    const entries = await loadEntries(collection.dir, markdownOf(collection.options).highlight, true, collection.options.localized === true, markdownOf(collection.options).headingLinks)

    decodeEntries(entries, collection.options.schema, collection.options.components ?? {}, collection.options.localized)
    await Bun.write(manifestFile(clientBase, collection.dir), JSON.stringify(entries))
    count += entries.length
  }

  // Every collection was compiled, so what no entry file owns any more can go.
  await pruneContentCache()

  return count
}

// Every entry that fails to compile or to match its schema, across the project's collections, and the components their Markdown uses, for `kay check`. A loader's entries are read only when the server runs.
// `site` says whether the config sets the site's URL, which a collection's feed needs.
export async function contentProblems(root: string, config?: string, site = true): Promise<{ problems: ContentProblem[], uses: ComponentUse[], feeds: CollectionFeed[], read: string[] }> {
  const problems: ContentProblem[] = []
  const uses: ComponentUse[] = []
  const feeds: CollectionFeed[] = []
  // What the collections were read from, beside the modules loaded: the config and each folder of entries.
  const read = [projectPaths(root, { content: config }).content]

  for (const [name, collection] of await namedCollections(root, config)) {
    if (collection.options.feed)
      feeds.push(collectionFeed(collection))

    if (collection.options.feed && !site)
      problems.push({ file: relative(root, projectPaths(root, { content: config }).content), line: 1, message: feedNeedsSite(collection).message })

    if (collection.dir === undefined)
      continue

    read.push(resolve(dirname(read[0]!), collection.dir))

    try {
      const entries = await loadEntries(collection.dir, markdownOf(collection.options).highlight, true, collection.options.localized === true, markdownOf(collection.options).headingLinks)

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

  return { problems, uses, feeds, read }
}

// A component the collection lacks is a content problem of its own, so only those it has are typed.
function componentUses(collection: string, components: object, file: string, segments: Segment[]): ComponentUse[] {
  return segments.flatMap(segment => typeof segment === 'string' || !Object.hasOwn(components, segment.component)
    ? []
    : [{ collection, component: segment.component, props: segment.props, children: segment.children.length > 0, file, line: segment.line }, ...componentUses(collection, components, file, segment.children)])
}

function feedNeedsSite(collection: Collection<unknown>): Error {
  return new KayError('feed-needs-site', `kay: the collection ${collection.name} has a feed, whose links need the site's URL: set \`site\` in kay.config.ts`)
}

function collectionFeed(collection: Collection<unknown>): CollectionFeed {
  return { collection: collection.name, path: collection.options.feed!.path, localized: collection.options.localized === true }
}

// Serves each collection's feed at its path; one stays cached for an hour in production.
// A localized collection's feed lists only the entries written in its locale, linking each at its path there.
export function serveFeeds(app: Elysia, served: ServedPaths, collections: Collection<unknown>[], origin: string | undefined, dev = false, i18n?: I18n, trailingSlash?: TrailingSlash): void {
  for (const collection of collections) {
    const { feed } = collection.options

    if (!feed)
      continue

    if (origin === undefined)
      throw feedNeedsSite(collection)

    const headers = { 'content-type': `${feed.format === 'atom' ? 'application/atom+xml' : 'application/rss+xml'}; charset=utf-8`, 'cache-control': dev ? 'no-cache' : 'public, max-age=3600' }

    for (const { path, locale } of claimFeed(served, collectionFeed(collection), i18n?.settings)) {
      const built = new Map<string, { entries: unknown[], xml: string }>()
      // The XML built from these very entries is served again, so `item` is taken to depend on the entry alone; a collection that read its entries afresh, or a request that sees others, builds it anew.
      const once = <Entry>(key: string, entries: Entry[], build: () => string) => {
        const last = built.get(key)

        if (last && last.entries.length === entries.length && last.entries.every((entry, index) => entry === entries[index]))
          return last.xml

        const xml = build()

        built.set(key, { entries, xml })

        return xml
      }

      app.get(path, async ({ request }) => {
        if (!i18n || collection.options.localized !== true) {
          const entries = await collection.all()

          return new Response(once('', entries, () => feedXml(entries, feed, origin, '/', trailingSlash)), { headers })
        }

        const { settings } = i18n
        const written = locale ?? hostLocale(settings, request)
        const host = settings.hosts?.[written]

        return runInLocale(stateFor(i18n, written, feed.path, request), async () => {
          const entries = (await collection.all(written)).filter(entry => entry.locale === written)
          const localized = { ...feed, path, item: (entry: Parameters<typeof feed.item>[0]) => {
            const item = feed.item(entry)

            return item && { ...item, path: localePath(settings, item.path, written, host) }
          } }

          return new Response(once(written, entries, () => feedXml(entries, localized, host === undefined ? origin : onHost(origin, host), localePath(settings, '/', written, host), trailingSlash)), { headers })
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

// The slugs each localized collection holds in each locale, drafts included, keyed by the name the content config exports it under, then by locale.
export async function localizedSlugs(root: string, config?: string): Promise<Map<string, Map<string, Set<string>>>> {
  const found = new Map<string, Map<string, Set<string>>>()

  for (const [name, collection] of await namedCollections(root, config)) {
    if (collection.options.localized !== true)
      continue

    const byLocale = new Map<string, Set<string>>()

    for (const { slug, locale } of await entries(name)) {
      if (locale !== undefined)
        byLocale.set(locale, (byLocale.get(locale) ?? new Set()).add(slug))
    }

    found.set(name, byLocale)
  }

  return found
}
