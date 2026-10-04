import type { Elysia } from 'elysia'
import type { Collection } from './index'
import type { ContentProblem } from './validate'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { bundled, importModule } from '../server/bundle'
import { registerLoader } from '../server/loader'
import { feedXml } from './feed'
import { isCollection } from './index'
import { loadEntries, manifestFile, setContentPlace } from './load'
import { ContentError, decodeEntries } from './validate'

// The module declaring a project's collections, which `kay build`, `kay check` and the server read them from.
export const CONTENT_CONFIG = 'src/content.config.ts'

// The collections the project's content config exports, or none without one; their folders are relative to it.
export async function projectCollections(root: string, config = CONTENT_CONFIG): Promise<Collection<unknown>[]> {
  const file = resolve(root, config)

  setContentPlace(root, dirname(file))

  const bundle = bundled()

  if (bundle ? !(file in bundle.modules) : !existsSync(file))
    return []

  // Its components are `.kay` files.
  if (!bundle)
    registerLoader(root)

  const module = await importModule<Record<string, unknown>>(file)

  return Object.values(module).filter(isCollection)
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

// Every entry that fails to compile or to match its schema, across the project's collections, for `kay check`.
export async function contentProblems(root: string, config?: string): Promise<ContentProblem[]> {
  const problems: ContentProblem[] = []

  for (const collection of await projectCollections(root, config)) {
    try {
      decodeEntries(await loadEntries(collection.dir, collection.options.highlight, true), collection.options.schema, collection.options.components ?? {})
    }
    catch (error) {
      if (!(error instanceof ContentError))
        throw error

      problems.push(...error.problems)
    }
  }

  return problems
}

// Serves each collection's feed at its path; one stays cached for an hour in production.
export function serveFeeds(app: Elysia, collections: Collection<unknown>[], origin: string | undefined, dev = false): void {
  for (const collection of collections) {
    const { feed } = collection.options

    if (!feed)
      continue

    if (origin === undefined)
      throw new Error(`kay: the collection ${collection.dir} has a feed, whose links need the site's URL: set \`site\` in kay.config.ts`)

    const type = feed.format === 'atom' ? 'application/atom+xml' : 'application/rss+xml'

    app.get(feed.path, async () => new Response(feedXml(await collection.all(), feed, origin), { headers: { 'content-type': `${type}; charset=utf-8`, 'cache-control': dev ? 'no-cache' : 'public, max-age=3600' } }))
  }
}
