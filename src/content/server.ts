import type { Elysia } from 'elysia'
import type { TrailingSlash } from '../config'
import type { LocaleState } from '../runtime/locale-state'
import type { I18n } from '../server/i18n'
import type { ServedPaths } from '../server/served-paths'

import type { CollectionFeed, CollectionRoute } from './claims'
import type { Collection, Entry } from './index'
import type { RawEntry } from './load'
import type { Segment } from './markdown'
import type { ContentProblem } from './validate'
import { dirname, relative, resolve } from 'node:path'
import { KayError } from '../compiler/errors'
import { loadConfig } from '../config-loader'
import { projectPaths } from '../project'
import { TRAILING_SLASH } from '../runtime/base'
import { nameCollection } from '../runtime/fields'
import { localePath } from '../runtime/i18n'
import { runInLocale } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { importModule } from '../server/bundle'
import { catalogFiles, defaultLocaleState, hostLocale, stateFor } from '../server/i18n'
import { pageEtag } from '../server/prerendered'
import { revalidated } from '../server/public'
import { projectSource } from '../server/source'
import { claimFeed } from './claims'
import { modifiedMode } from './drafts'
import { entries, registerCollections } from './edit'
import { defaultFeedItem, FEED_TYPES, feedDocument, feedItem, feedPaths, renderedBody, resolvedFeed } from './feed'
import { heldBack } from './held-back'
import { isCollection, toEntry } from './index'
import { bodiesFile, contentMode, contentOutput, draftCommentLine, loadEntries, manifestFile, markdownOf, pruneContentCache, setContentPlace, translationKey } from './load'
import { migrateEntries, withMigrationHint } from './migrate'
import { referencesIn } from './references'
import { ContentError, decodeEntries } from './validate'

// Enough of an entry's file to hold its first lines.
const DRAFT_HEAD_BYTES = 64

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
  const file = projectPaths(root, { contentConfig: config }).content

  setContentPlace(root, dirname(file), file)

  const source = projectSource()

  if (!source.has(file)) {
    if (config !== undefined && !source.embedded)
      throw new KayError('content-config-missing', `kay: kay.config.ts names ${config} as the content config, and there is no such file`)

    return []
  }

  // Its components are `.kay` files.
  await source.prepare(root, undefined, source.contentBuild(root, contentMode().prebuilt, contentOutput()))

  const module = await importModule<Record<string, unknown>>(file)

  const collections = Object.entries(module).filter((entry): entry is [string, Collection<unknown>] => isCollection(entry[1]))

  for (const [exported, collection] of collections)
    nameCollection(collection.name, exported)

  registerCollections(collections)

  return collections
}

// The site's default locale, so a refusal reads as the CMS words it for that locale's editor, else the English.
async function entryLocale(root: string): Promise<LocaleState | undefined> {
  try {
    return await defaultLocaleState(root, await loadConfig(root))
  }
  catch (error) {
    kayLog('warn', 'the config failed to load, so an entry\'s refusal is worded in English', error)

    return undefined
  }
}

// The catalogs a refusal is worded from, so a check sees one written after it ran.
async function catalogsOf(root: string): Promise<string[]> {
  try {
    return catalogFiles(root, await loadConfig(root))
  }
  catch {
    return []
  }
}

// What a build or a check reads entries in: run as is, and again in the site's default locale only when it refuses, the one case that words anything.
async function decodedIn<Result>(root: string, run: () => Result): Promise<Result> {
  try {
    return run()
  }
  catch (error) {
    if (!(error instanceof ContentError))
      throw error

    const state = await entryLocale(root)

    return state === undefined ? run() : runInLocale(state, run)
  }
}

// Compiles every collection from its files and writes what the server reads in production, failing on the first collection with a bad entry. A loader's collection is read when the server runs.
export async function writeContentManifests(root: string, clientBase: string, config?: string): Promise<number> {
  let count = 0
  const named = await namedCollections(root, config)
  const slugs = new Map<string, Promise<Map<string, boolean> | undefined>>()

  for (const [, collection] of named) {
    if (collection.dir === undefined)
      continue

    const entries = migrateEntries(collection.name, await loadEntries(collection.dir, { ...markdownOf(collection.options), live: true, localized: collection.options.localized === true, modified: modifiedMode(collection.options) }), collection.options.schema, collection.options.migrations)

    try {
      const decoded = await decodedIn(root, () => decodeEntries(entries, collection.options.schema, collection.options.components ?? {}, collection.options.localized))
      const dangling = await danglingReferences(root, collection, decoded, named, slugs)

      if (dangling.length > 0)
        throw new ContentError(dangling)
    }
    catch (error) {
      throw withMigrationHint(error, collection.options.migrations)
    }

    // The Markdown bodies go in a file of their own, read only when an entry's `body` is.
    const bodies = Object.fromEntries(entries.flatMap(entry => entry.body === undefined ? [] : [[entry.file, entry.body]]))

    await Bun.write(manifestFile(clientBase, collection.dir), JSON.stringify(entries.map(({ body: _body, ...rest }) => rest)))
    await Bun.write(bodiesFile(clientBase, collection.dir), JSON.stringify(bodies))
    count += entries.length
  }

  // Every collection was compiled, so what no entry file owns any more can go.
  await pruneContentCache()

  return count
}

// Every entry that fails to compile or to match its schema, across the project's collections, and the components their Markdown uses, for `kay check`. A loader's entries are read only when the server runs.
// `site` says whether the config sets the site's URL, which a collection's feed needs.
export async function contentProblems(root: string, config?: string, site = true): Promise<{ problems: ContentProblem[], uses: ComponentUse[], feeds: CollectionFeed[], routes: CollectionRoute[], read: string[] }> {
  const problems: ContentProblem[] = []
  const uses: ComponentUse[] = []
  const feeds: CollectionFeed[] = []
  const routes: CollectionRoute[] = []
  // What the collections were read from, beside the modules loaded: the config, the catalogs and each folder of entries.
  const read = [projectPaths(root, { contentConfig: config }).content, ...await catalogsOf(root)]
  const named = await namedCollections(root, config)
  const slugs = new Map<string, Promise<Map<string, boolean> | undefined>>()

  for (const [name, collection] of named) {
    if (collection.options.feed)
      feeds.push(collectionFeed(collection))

    if (collection.options.route !== undefined)
      routes.push({ collection: name, route: collection.options.route, ...collection.options.single === true && { single: true as const } })

    if (collection.options.feed && !site)
      problems.push({ file: relative(root, projectPaths(root, { contentConfig: config }).content), line: 1, message: feedNeedsSite(collection).message })

    if (collection.options.feed && collection.options.route === undefined && !collection.options.feed.item)
      problems.push({ file: relative(root, projectPaths(root, { contentConfig: config }).content), line: 1, message: `the feed of the collection ${collection.name} has no \`item\` and the collection no \`route\`, so its items link nowhere; set \`item\` in the feed, or a \`route\` on the collection` })

    if (collection.options.trusted !== undefined && collection.loader === undefined)
      problems.push({ file: relative(root, projectPaths(root, { contentConfig: config }).content), line: 1, message: `the collection ${collection.name} sets \`trusted\`, which only a loader's collection reads: a folder's files always keep their raw HTML`, code: 'trusted-folder' })

    if (collection.dir === undefined)
      continue

    read.push(resolve(dirname(read[0]!), collection.dir))

    try {
      const entries = migrateEntries(collection.name, await loadEntries(collection.dir, { ...markdownOf(collection.options), live: true, localized: collection.options.localized === true, modified: modifiedMode(collection.options) }), collection.options.schema, collection.options.migrations)

      for (const entry of entries)
        uses.push(...componentUses(name, collection.components, entry.file, entry.segments ?? []))

      const decoded = await decodedIn(root, () => decodeEntries(entries, collection.options.schema, collection.options.components ?? {}, collection.options.localized))

      problems.push(...await danglingReferences(root, collection, decoded, named, slugs, problems))

      if (collection.options.feed)
        problems.push(...await feedProblems(collection, decoded))

      if (collection.options.localized === true)
        problems.push(...await draftEntryProblems(root, entries))
    }
    catch (error) {
      if (!(error instanceof ContentError))
        throw error

      // The hint of the build's error, on the first refused entry of the collection.
      const { problems: refused, hint } = withMigrationHint(error, collection.options.migrations) as ContentError

      problems.push(...refused.map((problem, index) => index === 0 && hint !== undefined ? { ...problem, message: `${problem.message}; ${hint}` } : problem))
    }
  }

  return { problems, uses, feeds, routes, read }
}

const KAY_PREFIX = /^kay: /

// The slugs a folder collection holds, a localized one's without their locale, each with whether every entry of it is held back from production; undefined for a loader's collection, whose entries are read when the server runs, and for a folder that does not read, which its own problems report.
export async function slugsOf(root: string, collection: Collection<unknown>): Promise<Map<string, boolean> | undefined> {
  const { dir } = collection

  if (dir === undefined)
    return undefined

  const localized = collection.options.localized === true

  try {
    const markdown = markdownOf(collection.options)
    const found = await loadEntries(dir, { ...markdown, live: true, localized, modified: modifiedMode(collection.options) })

    const { draft, publishAt, unpublishAt } = collection.options
    // Decoding is only needed to read a draft or a publication date, and an entry that does not decode is not told held back.
    let data: Map<RawEntry, unknown> | undefined

    try {
      data = draft === undefined && publishAt === undefined && unpublishAt === undefined ? undefined : new Map((await decodedIn(root, () => decodeEntries(found, collection.options.schema, collection.options.components ?? {}, localized))).map(({ entry, data }) => [entry, data]))
    }
    catch (error) {
      if (!(error instanceof ContentError))
        throw error
    }

    const held = new Map<string, boolean>()

    for (const entry of found) {
      const slug = localized ? entry.slug.slice(entry.slug.indexOf('/') + 1) : entry.slug

      held.set(slug, (held.get(slug) ?? true) && data !== undefined && heldBackRaw(collection, markdown, entry, data.get(entry)))
    }

    return held
  }
  catch (error) {
    if (error instanceof ContentError)
      return undefined

    throw error
  }
}

// The `reference()` fields of a folder collection's entries that name a slug the target has no entry for, or a collection the content config does not export, on the line of the field's key.
// `notes` takes, when given, the references of an entry shown to one held back from production, which the site then renders as no link or none.
async function danglingReferences(root: string, collection: Collection<unknown>, decoded: { entry: RawEntry, data: unknown }[], named: [string, Collection<unknown>][], slugs: Map<string, Promise<Map<string, boolean> | undefined>>, notes?: ContentProblem[]): Promise<ContentProblem[]> {
  const found: ContentProblem[] = []
  const markdown = markdownOf(collection.options)

  for (const { entry, data } of decoded) {
    const shown = notes !== undefined && !heldBackRaw(collection, markdown, entry, data)

    for (const use of referencesIn(collection.options.schema, data)) {
      const target = named.find(([name]) => name === use.collection)?.[1]
      const line = entry.lines[use.field] ?? 1

      if (target === undefined) {
        found.push({ file: entry.file, line, message: `${use.path}: references the collection ${use.collection}, which the content config does not export` })

        continue
      }

      if (!slugs.has(use.collection))
        slugs.set(use.collection, slugsOf(root, target))

      const held = await slugs.get(use.collection)

      if (held !== undefined && !held.has(use.slug))
        found.push({ file: entry.file, line, message: `${use.path}: references ${use.slug}, which ${use.collection} has no entry for` })
      else if (shown && held?.get(use.slug) === true)
        notes?.push({ file: entry.file, line, message: `${use.path}: references ${use.slug}, which ${use.collection} holds back from production (a draft, or outside its publication dates)`, code: 'held-back-reference' })
    }
  }

  return found
}

// What a feed shows of an entry that the entry lacks: a title or a date the default item reads, or a body that does not render at once.
async function feedProblems(collection: Collection<unknown>, decoded: { entry: RawEntry, data: unknown }[]): Promise<ContentProblem[]> {
  const found: ContentProblem[] = []
  const { feed } = collection.options

  if (!feed?.item) {
    const item = defaultFeedItem(collection)

    for (const { entry, data } of decoded) {
      try {
        item({ file: entry.file, data } as Entry<unknown>)
      }
      catch (error) {
        if (!(error instanceof KayError))
          throw error

        found.push({ file: entry.file, line: 1, message: error.message.replace(KAY_PREFIX, '') })
      }
    }
  }

  if (feed?.content === true) {
    let all: Entry<unknown>[] = []

    try {
      all = await collection.all()
    }
    catch {}

    for (const entry of all.filter(each => renderedBody(each) === undefined))
      found.push({ file: entry.file, line: 1, message: `the feed of the collection ${collection.name} cannot carry the body of this entry, whose content does not render at once, so it shows its summary alone` })
  }

  return found
}

// The entries of a localized collection marked with `# draft`, as `writeDraftEntry` marks a machine translation without a draft field.
async function draftEntryProblems(root: string, entries: RawEntry[]): Promise<ContentProblem[]> {
  const found = await Promise.all(entries.filter(entry => !entry.file.endsWith('.json')).map(async (entry): Promise<ContentProblem[]> => {
    const line = draftCommentLine(entry.file, await Bun.file(resolve(root, entry.file)).slice(0, DRAFT_HEAD_BYTES).text())

    return line === undefined ? [] : [{ file: entry.file, line, message: 'is marked `# draft`, a machine translation no one has checked yet', code: 'draft-entry' }]
  }))

  return found.flat()
}

// A component the collection lacks is a content problem of its own, so only those it has are typed.
function componentUses(collection: string, components: object, file: string, segments: Segment[]): ComponentUse[] {
  return segments.flatMap(segment => typeof segment === 'string' || !Object.hasOwn(components, segment.component)
    ? []
    : [{ collection, component: segment.component, props: segment.props, children: segment.children.length > 0, file, line: segment.line }, ...componentUses(collection, components, file, segment.children)])
}

// Refuses a collection with a feed when the site has no URL, which its links need.
export function refuseFeedsWithoutSite(collections: Collection<unknown>[], origin: string | undefined): void {
  const feeding = collections.find(collection => collection.options.feed)

  if (feeding && origin === undefined)
    throw feedNeedsSite(feeding)
}

function feedNeedsSite(collection: Collection<unknown>): Error {
  return new KayError('feed-needs-site', `kay: the collection ${collection.name} has a feed, whose links need the site's URL: set \`site\` in kay.config.ts`)
}

function collectionFeed(collection: Collection<unknown>): CollectionFeed {
  const [first, ...others] = feedPaths(collection.options.feed!)

  return { collection: collection.name, path: first!.path, also: others.map(other => other.path), localized: collection.options.localized === true }
}

// Serves each collection's feed at its path; one stays cached for an hour in production, then revalidates by its ETag, answering 304 while unchanged.
// A localized collection's feed lists only the entries written in its locale, linking each at its path there.
export function serveFeeds(app: Elysia, served: ServedPaths, collections: Collection<unknown>[], origin: string, dev = false, i18n?: I18n, trailingSlash?: TrailingSlash): void {
  for (const collection of collections) {
    if (!collection.options.feed)
      continue

    const feed = resolvedFeed(collection)
    const cache = dev ? 'no-cache' : 'public, max-age=3600'

    for (const { format, path: formatPath } of feedPaths(feed)) {
      const headers = { 'content-type': `${FEED_TYPES[format]}; charset=utf-8` }

      for (const { path, locale } of claimFeed(served, { ...collectionFeed(collection), path: formatPath, also: [] }, i18n?.settings)) {
        const built = new Map<string, { entries: unknown[], xml: string, etag: string }>()
        // The XML built from these very entries is served again, so `item` is taken to depend on the entry alone; a collection that read its entries afresh, or a request that sees others, builds it anew.
        const once = <Entry>(request: Request, key: string, entries: Entry[], build: () => string) => {
          const last = built.get(key)
          let current = last

          if (!last || last.entries.length !== entries.length || !last.entries.every((entry, index) => entry === entries[index])) {
            const xml = build()

            current = { entries, xml, etag: pageEtag(xml) }
            built.set(key, current)
          }

          const { xml, etag } = current!

          return revalidated(request, etag, () => xml, headers, cache)
        }

        app.get(path, async ({ request }) => {
          if (!i18n || collection.options.localized !== true) {
            const entries = await collection.all()

            return once(request, '', entries, () => feedDocument(format, entries, feed, origin, '/', trailingSlash, path))
          }

          const { settings } = i18n
          const written = locale ?? hostLocale(settings, request)
          const host = settings.hosts?.[written]

          return runInLocale(stateFor(i18n, written, feed.path, request), async () => {
            const entries = (await collection.all(written)).filter(entry => entry.locale === written)
            const localized = { ...feed, item: (entry: Entry<unknown>) => {
              const item = feedItem(feed, entry)

              return item && { ...item, path: localePath(settings, item.path, written, host) }
            } }

            return once(request, written, entries, () => feedDocument(format, entries, localized, host === undefined ? origin : onHost(origin, host), localePath(settings, '/', written, host), trailingSlash, path))
          })
        })
      }
    }
  }
}

// The site's origin, its mount point kept, on another host.
function onHost(origin: string, host: string): string {
  const url = new URL(origin)

  url.host = host

  return url.href.replace(TRAILING_SLASH, '')
}

// Each localized collection's entries in each locale, drafts included, as their slug under the key pairing them with their translations (the slug unless they set a `translationKey`); keyed by the name the content config exports it under, then by locale.
export async function localizedSlugs(root: string, config?: string): Promise<Map<string, Map<string, Map<string, string>>>> {
  const found = new Map<string, Map<string, Map<string, string>>>()

  for (const [name, collection] of await namedCollections(root, config)) {
    if (collection.options.localized !== true)
      continue

    const byLocale = new Map<string, Map<string, string>>()

    for (const entry of await entries(name)) {
      if (entry.locale !== undefined)
        byLocale.set(entry.locale, (byLocale.get(entry.locale) ?? new Map<string, string>()).set(translationKey(entry), entry.slug))
    }

    found.set(name, byLocale)
  }

  return found
}

// Whether production holds an entry back, its `draft` function reading the entry the app reads, with its `excerpt`, `body` and `html`.
function heldBackRaw(collection: Collection<unknown>, markdown: ReturnType<typeof markdownOf>, raw: RawEntry, data: unknown): boolean {
  const { readingSpeed, imageSizes } = markdown

  return heldBack(collection.options, toEntry(raw, data, (collection.options.components ?? {}), collection.options.localized === true, readingSpeed, imageSizes, undefined))
}
