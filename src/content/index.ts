import type { Static, TSchema } from 'elysia'
import type { CacheStore } from '../runtime/cache'
import type { Duration } from '../runtime/duration'
import type { Html } from '../runtime/html'
import type { Component } from '../runtime/jsx'
import type { FeedOptions } from './feed'
import type { RawEntry } from './load'
import type { Heading, Highlighter, Segment } from './markdown'
import type { ContentProblem } from './validate'
import process from 'node:process'
import { cached, invalidate } from '../runtime/cache'
import { durationSeconds } from '../runtime/duration'
import { child } from '../runtime/html'
import { previewing, previewState } from '../runtime/preview'
import { loadEntries } from './load'
import { compileMarkdown, MarkdownError } from './markdown'
import { ContentError, decodeEntries } from './validate'

export type { FeedItem, FeedOptions } from './feed'
export type { Heading, Highlighter, RenderedMarkdown } from './markdown'
export { highlightCode, renderMarkdown } from './markdown'

export const COLLECTION = Symbol.for('kay.collection')
// Loaded entries are kept until `invalidate()` or a restart unless the loader sets a `ttl`: about thirty years.
const FOREVER = 1e9

export interface Entry<Data> {
  // The file's path in the collection without its extension, `guides/intro` for `guides/intro.md`; an `index` file takes its folder's.
  slug: string
  data: Data
  // A Markdown entry's headings, in order, for a table of contents; empty for a data file.
  headings: Heading[]
  // Renders a Markdown entry's body, the kay components it uses included; renders nothing for a data file.
  Content: Component
  // The file, relative to the project root; a loaded entry's collection name and slug, `posts/hello`.
  file: string
}

// One entry a loader gives: its data, read against the schema as a file's, and its body as Markdown or as HTML.
export interface LoadedEntry {
  slug: string
  data: unknown
  // Markdown, compiled as a file entry's body is: headings listed, code highlighted, the collection's components usable.
  body?: string
  // HTML rendered as it is, such as a CMS's rendered content: trusted, as a file entry's is.
  html?: string
}

// Where a collection takes its entries from instead of a folder: an API, a headless CMS, a database.
export interface ContentLoader {
  // Names the collection in messages and keys its cache.
  name: string
  // Every entry, drafts included; `preview` is true for a visitor in preview mode and in `kay dev`, for a CMS that serves drafts apart.
  load: (context: { preview: boolean }) => LoadedEntry[] | Promise<LoadedEntry[]>
  // How long the entries are served before the next read refreshes them in the background, as `cached` does; without it, until `invalidate()` or a restart.
  ttl?: Duration
  // Keeps the entries across restarts and processes, as `cached` does.
  store?: CacheStore
}

export interface CollectionOptions<Schema extends TSchema> {
  // What each entry's frontmatter, or a data file's content, holds; an entry it refuses fails `kay check` and the build.
  schema: Schema
  // The kay components a Markdown entry may use, by the name it writes them with: `<Callout type="warn">`.
  components?: Record<string, Component<never>>
  // Highlights code blocks when the entries compile, at build time, such as with Shiki.
  highlight?: Highlighter
  // Entries left out everywhere but `kay dev` and preview mode: from `all()`, `get()`, prerendering, the sitemap and the feed.
  draft?: (entry: Entry<Static<Schema>>) => boolean
  // The order `all()` lists entries in; by slug otherwise.
  sort?: (a: Entry<Static<Schema>>, b: Entry<Static<Schema>>) => number
  // An RSS or Atom feed of the collection, served at its path.
  feed?: FeedOptions<Static<Schema>>
}

export interface Collection<Data, Components extends Record<string, Component<never>> = Record<string, Component<never>>> {
  readonly [COLLECTION]: true
  // The folder, relative to the project root, or the loader's name.
  readonly name: string
  // The folder, or undefined for a collection a loader fills.
  readonly dir: string | undefined
  readonly options: CollectionOptions<TSchema>
  // The components its Markdown entries may use, typed as given, which `kay check` reads their props from.
  readonly components: Components
  // Every entry, in the collection's order.
  all: () => Promise<Entry<Data>[]>
  // The entry with that slug, or undefined.
  get: (slug: string) => Promise<Entry<Data> | undefined>
  // Loads the entries afresh on the next read: for a webhook a CMS calls once an entry changed. A loader's `store` passes it to every process sharing it.
  invalidate: () => void
}

interface Entries<Data> {
  list: Entry<Data>[]
  bySlug: Map<string, Entry<Data>>
}

// A folder of Markdown files, or of JSON and YAML data files, read against a schema: `collection('src/content/posts', { schema })`; or the entries a loader gives, `collection({ name: 'posts', load }, { schema })`.
// File entries compile once, each cached by its content, so a change recompiles only that entry; `kay build` compiles them all ahead for production. Loaded entries are read when first asked for, and kept as `cached` keeps a value.
export function collection<Schema extends TSchema, Components extends Record<string, Component<never>> = Record<never, never>>(source: string | ContentLoader, options: CollectionOptions<Schema> & { components?: Components }): Collection<Static<Schema>, Components> {
  type Data = Static<Schema>
  let loading: Promise<Entries<Data>> | undefined
  const components = options.components ?? {}
  const loader = typeof source === 'string' ? undefined : source
  const name = typeof source === 'string' ? source : source.name
  const key = `kay:content:${name}`
  const decoded = new WeakMap<RawEntry[], Entries<Data>>()
  const { draft } = options

  const decode = (raw: RawEntry[]): Entries<Data> => {
    const entries = decodeEntries(raw, options.schema, components).map(({ entry, data }) => toEntry<Data>(entry, data as Data, components))

    entries.sort(options.sort ?? ((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))

    return { list: entries, bySlug: new Map(entries.map(entry => [entry.slug, entry])) }
  }

  // Validated before `cached` keeps them, so entries the schema refuses are fetched again on the next read.
  const fetchLoaded = async (preview: boolean) => {
    const raw = await compileLoaded(loader!, preview, options.highlight)

    decodeEntries(raw, options.schema, components)

    return raw
  }

  const fromFolder = async () => {
    loading ??= (async () => decode(await loadEntries(source as string, options.highlight)))()

    try {
      return await loading
    }
    // A collection that failed to load tries again on the next call, once its files are fixed.
    catch (error) {
      loading = undefined

      throw error
    }
  }

  const fromLoader = async (): Promise<Entries<Data>> => {
    const preview = previewState()

    // A visitor in preview mode gets what the loader gives now, once per request, which no other visitor is served.
    if (preview) {
      let loads = preview.loads.get(key) as Promise<Entries<Data>> | undefined

      if (!loads)
        preview.loads.set(key, loads = (async () => decode(await compileLoaded(loader!, true, options.highlight)))())

      return loads
    }

    const raw = await cached(key, loader!.ttl === undefined ? FOREVER : durationSeconds(loader!.ttl, `the collection ${name}'s ttl`), async () => fetchLoaded(process.env.NODE_ENV === 'development'), { store: loader!.store })
    let entries = decoded.get(raw)

    if (!entries)
      decoded.set(raw, entries = decode(raw))

    return entries
  }

  const loaded = loader ? fromLoader : fromFolder
  const hidden = (entry: Entry<Data>) => draft !== undefined && process.env.NODE_ENV !== 'development' && !previewing() && draft(entry)

  return {
    [COLLECTION]: true,
    name,
    dir: loader ? undefined : name,
    options,
    components: components as Components,
    all: async () => (await loaded()).list.filter(entry => !hidden(entry)),
    get: async (slug) => {
      const entry = (await loaded()).bySlug.get(slug)

      return entry && !hidden(entry) ? entry : undefined
    },
    invalidate: () => {
      loading = undefined

      if (loader)
        invalidate(key)
    },
  }
}

// What a loader gives, compiled as files are: a Markdown body into segments and headings, HTML as one segment; two entries sharing a slug fail the collection.
async function compileLoaded(loader: ContentLoader, preview: boolean, highlight: Highlighter | undefined): Promise<RawEntry[]> {
  const given: unknown = await loader.load({ preview })

  if (!Array.isArray(given))
    throw new Error(`kay: the collection ${loader.name}'s load gave ${given === null ? 'null' : typeof given}, where it gives an array of entries`)

  const problems: ContentProblem[] = []
  const slugs = new Set<string>()
  const entries: RawEntry[] = []

  for (const [index, item] of (given as unknown[]).entries()) {
    const { slug, data, body, html } = (typeof item === 'object' && item !== null ? item : {}) as Partial<LoadedEntry>

    if (typeof slug !== 'string' || slug === '') {
      problems.push({ file: `${loader.name}[${index}]`, line: 1, message: 'has no slug: an entry gives a non-empty string' })

      continue
    }

    const file = `${loader.name}/${slug}`

    if (slugs.has(slug)) {
      problems.push({ file, line: 1, message: `has the slug ${slug}, as an earlier entry does` })

      continue
    }

    slugs.add(slug)

    try {
      const compiled = typeof body === 'string' ? await compileMarkdown(body, 1, highlight) : typeof html === 'string' ? { segments: [html], headings: [] } : undefined

      entries.push({ slug, file, data, lines: {}, segments: compiled?.segments, headings: compiled?.headings })
    }
    catch (error) {
      problems.push({ file, line: error instanceof MarkdownError ? error.line : 1, message: error instanceof Error ? error.message : String(error) })
    }
  }

  if (problems.length > 0)
    throw new ContentError(problems)

  return entries
}

export function isCollection(value: unknown): value is Collection<unknown> {
  return typeof value === 'object' && value !== null && COLLECTION in value
}

function toEntry<Data>(entry: RawEntry, data: Data, components: Record<string, Component<never>>): Entry<Data> {
  const segments = entry.segments ?? []

  return {
    slug: entry.slug,
    data,
    headings: entry.headings ?? [],
    Content: () => render(segments, components, entry.file),
    file: entry.file,
  }
}

// The markup of the segments, each component called as a template calls it: its props, and what it wraps as `children`.
function render(segments: Segment[], components: Record<string, Component<never>>, file: string): Html {
  let markup = ''

  for (const segment of segments) {
    if (typeof segment === 'string') {
      markup += segment

      continue
    }

    const component = components[segment.component] as ((props: Record<string, unknown>) => unknown) | undefined

    if (!component)
      throw new Error(`kay: ${file} uses <${segment.component}>, which its collection's components do not name`)

    const { children } = segment
    // An island takes no children, so a self-closing tag passes none.
    const props = children.length === 0
      ? segment.props
      : { ...segment.props, get children() {
        return render(children, components, file)
      } }

    markup += child(component(props))
  }

  return { t: markup }
}
