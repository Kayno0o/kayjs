import type { Elysia } from 'elysia'
import type { Collection } from './index'
import type { Segment } from './markdown'
import type { ContentProblem } from './validate'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { bundled, importModule } from '../server/bundle'
import { registerLoader } from '../server/loader'
import { feedXml } from './feed'
import { isCollection } from './index'
import { loadEntries, manifestFile, setContentPlace } from './load'
import { ContentError, decodeEntries } from './validate'

// The module declaring a project's collections, which `kay build`, `kay check` and the server read them from.
export const CONTENT_CONFIG = 'src/content.config.ts'

// Starts the line `kay check` reads the content problems from.
export const PROBLEMS_MARKER = 'kay-content-problems:'
// Starts the line `kay check` reads the components Markdown entries use from.
export const USES_MARKER = 'kay-content-uses:'

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
  const file = resolve(root, config ?? CONTENT_CONFIG)

  setContentPlace(root, dirname(file))

  const bundle = bundled()

  if (bundle ? !(file in bundle.modules) : !existsSync(file)) {
    if (config !== undefined && !bundle)
      throw new Error(`kay: kay.config.ts names ${config} as the content config, and there is no such file`)

    return []
  }

  // Its components are `.kay` files.
  if (!bundle)
    await registerLoader(root)

  const module = await importModule<Record<string, unknown>>(file)

  return Object.entries(module).filter((entry): entry is [string, Collection<unknown>] => isCollection(entry[1]))
}

// Compiles every collection from its files and writes what the server reads in production, failing on the first collection with a bad entry.
export async function writeContentManifests(root: string, clientBase: string, config?: string): Promise<number> {
  let count = 0

  for (const collection of await projectCollections(root, config)) {
    const entries = await loadEntries(collection.dir, collection.options.highlight, true)

    decodeEntries(entries, collection.options.schema, collection.options.components ?? {})
    await Bun.write(manifestFile(clientBase, collection.dir), JSON.stringify(entries))
    count += entries.length
  }

  return count
}

// Every entry that fails to compile or to match its schema, across the project's collections, and the components their Markdown uses, for `kay check`.
// `site` says whether the config sets the site's URL, which a collection's feed needs.
export async function contentProblems(root: string, config?: string, site = true): Promise<{ problems: ContentProblem[], uses: ComponentUse[] }> {
  const problems: ContentProblem[] = []
  const uses: ComponentUse[] = []

  for (const [name, collection] of await namedCollections(root, config)) {
    if (collection.options.feed && !site)
      problems.push({ file: relative(root, resolve(root, config ?? CONTENT_CONFIG)), line: 1, message: feedNeedsSite(collection).message })

    try {
      const entries = await loadEntries(collection.dir, collection.options.highlight, true)

      for (const entry of entries)
        uses.push(...componentUses(name, collection.components, entry.file, entry.segments ?? []))

      decodeEntries(entries, collection.options.schema, collection.options.components ?? {})
    }
    catch (error) {
      if (!(error instanceof ContentError))
        throw error

      problems.push(...error.problems)
    }
  }

  return { problems, uses }
}

// A component the collection lacks is a content problem of its own, so only those it has are typed.
function componentUses(collection: string, components: object, file: string, segments: Segment[]): ComponentUse[] {
  return segments.flatMap(segment => typeof segment === 'string' || !Object.hasOwn(components, segment.component)
    ? []
    : [{ collection, component: segment.component, props: segment.props, children: segment.children.length > 0, file, line: segment.line }, ...componentUses(collection, components, file, segment.children)])
}

function feedNeedsSite(collection: Collection<unknown>): Error {
  return new Error(`kay: the collection ${collection.dir} has a feed, whose links need the site's URL: set \`site\` in kay.config.ts`)
}

// Serves each collection's feed at its path; one stays cached for an hour in production.
export function serveFeeds(app: Elysia, collections: Collection<unknown>[], origin: string | undefined, dev = false): void {
  for (const collection of collections) {
    const { feed } = collection.options

    if (!feed)
      continue

    if (origin === undefined)
      throw feedNeedsSite(collection)

    const type = feed.format === 'atom' ? 'application/atom+xml' : 'application/rss+xml'

    app.get(feed.path, async () => new Response(feedXml(await collection.all(), feed, origin), { headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': dev ? 'no-cache' : 'public, max-age=3600' } }))
  }
}
