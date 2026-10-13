import type { Static, TSchema } from 'elysia'
import type { CacheStore } from '../runtime/cache'
import type { Duration } from '../runtime/duration'
import type { Html } from '../runtime/html'
import type { Component } from '../runtime/jsx'
import type { FeedOptions } from './feed'
import type { RawEntry } from './load'
import type { Heading, Highlighter, Segment } from './markdown'
import type { ContentProblem } from './validate'
import { cached, invalidate } from '../runtime/cache'
import { durationSeconds } from '../runtime/duration'
import { editableEntries } from '../runtime/fields'
import { child, localLinks } from '../runtime/html'
import { localeState } from '../runtime/locale-state'
import { previewing, previewState } from '../runtime/preview'
import { isDraft } from './drafts'
import { contentMode, loadEntries } from './load'
import { compileMarkdown, MarkdownError } from './markdown'
import { ContentError, decodeEntries } from './validate'

export type { CollectionInfo, DataValue, EntryFile, EntryFilter, EntryPath, FieldKind, JsonSchema, SourceEntry, WrittenEntry } from './edit'
export { collectionInfo, collections, entries, entryFile, entrySource, fileField, imageField, markdownField, reference, removeEntry, repositoryRoot, saveEntry } from './edit'
export type { FeedItem, FeedOptions } from './feed'
export type { Heading, Highlighter, RenderedMarkdown } from './markdown'
export { highlightCode, renderMarkdown } from './markdown'
export type { Page, Paginated } from './paginate'
export { isPaginated, paginate } from './paginate'

export const COLLECTION = Symbol.for('kay.collection')
// Never set: it only carries a feed's path in the collection's type, for `kay check` to count it as served.
declare const FEED_PATH: unique symbol
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
  // In a localized collection, the locale whose folder holds the entry, the default one's when it stands in for a locale lacking it.
  locale?: string | undefined
  // In a localized collection, the locales with an entry of this slug, its own included.
  translations?: readonly string[] | undefined
}

// One entry a loader gives: its data, read against the schema as a file's, and its body as Markdown or as HTML.
export interface LoadedEntry {
  slug: string
  data: unknown
  // Markdown, compiled as a file entry's body is: headings listed, code highlighted, the collection's components usable.
  body?: string | undefined
  // HTML rendered as it is, such as a CMS's rendered content: trusted, as a file entry's is.
  html?: string | undefined
}

// Where a collection takes its entries from instead of a folder: an API, a headless CMS, a database.
export interface ContentLoader {
  // Names the collection in messages and keys its cache.
  name: string
  // Every entry, drafts included; `preview` is true for a visitor in preview mode and in `kay dev`, for a CMS that serves drafts apart.
  load: (context: { preview: boolean }) => LoadedEntry[] | Promise<LoadedEntry[]>
  // How long the entries are served before the next read refreshes them in the background, as `cached` does; without it, until `invalidate()` or a restart.
  ttl?: Duration | undefined
  // Keeps the entries across restarts and processes, as `cached` does.
  store?: CacheStore | undefined
  // Writes an entry a CMS saved, new or changed, once its collection accepts it: what `saveEntry` from `kay/content` hands on. `create` is true for an entry the CMS creates: throw when it exists, or another process's new entry is overwritten.
  save?: ((entry: { slug: string, locale?: string | undefined, data: unknown, body?: string | undefined, create?: true }) => void | Promise<void>) | undefined
  // Deletes an entry, which `removeEntry` from `kay/content` asks.
  remove?: ((entry: { slug: string, locale?: string | undefined }) => void | Promise<void>) | undefined
}

// The fields of the data holding a boolean, which `draft` may name.
type BooleanField<Data> = { [Name in keyof Data]-?: Data[Name] extends boolean | undefined ? Name : never }[keyof Data] & string

export interface CollectionOptions<Schema extends TSchema> {
  // What each entry's frontmatter, or a data file's content, holds; an entry it refuses fails `kay check` and the build.
  schema: Schema
  // The kay components a Markdown entry may use, by the name it writes them with: `<Callout type="warn">`.
  components?: Record<string, Component<never>> | undefined
  // Highlights code blocks when the entries compile, at build time, such as with Shiki.
  highlight?: Highlighter | undefined
  // Entries left out everywhere but `kay dev` and preview mode: from `all()`, `get()`, prerendering, the sitemap and the feed. A boolean field's name, `'draft'`, leaves out those where it is true, which a CMS then reads and writes.
  draft?: ((entry: Entry<Static<Schema>>) => boolean) | BooleanField<Static<Schema>> | undefined
  // The order `all()` lists entries in; by slug otherwise.
  sort?: ((a: Entry<Static<Schema>>, b: Entry<Static<Schema>>) => number) | undefined
  // An RSS or Atom feed of the collection, served at its path.
  feed?: FeedOptions<Static<Schema>> | undefined
  // Each entry sits in a folder named after its locale, `fr/hello.md`, a translation sharing its slug: `all()` and `get()` read the request's locale, the default locale's entry standing in for one it lacks, and the feed is served once per locale.
  localized?: boolean | undefined
  // The path of the page showing an entry, under the base, which a CMS opens it on; by default the page whose `prerender` lists the collection.
  url?: ((entry: { slug: string, locale?: string | undefined, data: Static<Schema> }) => string) | undefined
}

export interface Collection<Data, Components extends Record<string, Component<never>> = Record<string, Component<never>>, FeedPath extends string = string> {
  readonly [COLLECTION]: true
  readonly [FEED_PATH]?: FeedPath
  // The folder, relative to the project root, or the loader's name.
  readonly name: string
  // The folder, or undefined for a collection a loader fills.
  readonly dir: string | undefined
  // The loader filling it, or undefined for a folder's.
  readonly loader: ContentLoader | undefined
  readonly options: CollectionOptions<TSchema>
  // The components its Markdown entries may use, typed as given, which `kay check` reads their props from.
  readonly components: Components
  // Every entry, in the collection's order; in a localized collection those of the request's locale or the one given, or every locale's outside a request.
  all: (locale?: string) => Promise<Entry<Data>[]>
  // The entry with that slug, or undefined; in a localized collection the request's locale's or the one given.
  get: (slug: string, locale?: string) => Promise<Entry<Data> | undefined>
  // Loads the entries afresh on the next read: for a webhook a CMS calls once an entry changed. A loader's `store` passes it to every process sharing it.
  invalidate: () => void
}

interface Entries<Data> {
  list: Entry<Data>[]
  bySlug: Map<string, Entry<Data>>
  // A localized collection's entries by locale, then slug.
  byLocale: Map<string, Map<string, Entry<Data>>>
}

// A folder of Markdown files, or of JSON and YAML data files, read against a schema: `collection('src/content/posts', { schema })`; or the entries a loader gives, `collection({ name: 'posts', load }, { schema })`.
// File entries compile once, each cached by its content, so a change recompiles only that entry; `kay build` compiles them all ahead for production. Loaded entries are read when first asked for, and kept as `cached` keeps a value.
export function collection<Schema extends TSchema, Components extends Record<string, Component<never>> = Record<never, never>, const FeedPath extends string = string>(source: string | ContentLoader, options: CollectionOptions<Schema> & { components?: Components, feed?: { path: FeedPath } | undefined }): Collection<Static<Schema>, Components, FeedPath> {
  type Data = Static<Schema>
  let loading: Promise<Entries<Data>> | undefined
  const components = options.components ?? {}
  const loader = typeof source === 'string' ? undefined : source
  const name = typeof source === 'string' ? source : source.name
  const key = `kay:content:${name}`
  const decoded = new WeakMap<RawEntry[], Entries<Data>>()
  const raws = new WeakMap<Entries<Data>, RawEntry[]>()
  const { draft, localized = false } = options

  const decodeEach = (raw: RawEntry[]) => decodeEntries(raw, options.schema, components, localized).map(({ entry, data }) => toEntry<Data>(entry, data as Data, components, localized))

  // Sorts the entries and maps them by slug and locale, setting each one's translations.
  const indexed = (entries: Entry<Data>[]): Entries<Data> => {
    const byLocale = new Map<string, Map<string, Entry<Data>>>()

    entries.sort(options.sort ?? ((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : a.locale! < b.locale! ? -1 : 1))

    for (const entry of entries) {
      if (entry.locale === undefined)
        continue

      const slugs = byLocale.get(entry.locale) ?? new Map<string, Entry<Data>>()

      byLocale.set(entry.locale, slugs.set(entry.slug, entry))
    }

    for (const entry of entries) {
      if (localized)
        entry.translations = [...byLocale].filter(([, slugs]) => slugs.has(entry.slug)).map(([locale]) => locale).sort()
    }

    return { list: entries, bySlug: new Map(entries.map(entry => [entry.slug, entry])), byLocale }
  }

  const decode = (raw: RawEntry[]): Entries<Data> => {
    const result = indexed(decodeEach(raw))

    raws.set(result, raw)

    return result
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

    const raw = await cached(key, loader!.ttl === undefined ? FOREVER : durationSeconds(loader!.ttl, `the collection ${name}'s ttl`), async () => fetchLoaded(contentMode().dev), { store: loader!.store })
    let entries = decoded.get(raw)

    if (!entries)
      decoded.set(raw, entries = decode(raw))

    return entries
  }

  // The entries an editor has not saved stand in for theirs, for the request rendering them alone.
  const withDrafts = async (entries: Entries<Data>): Promise<Entries<Data>> => {
    const preview = previewState()
    const drafts = preview?.drafts?.get(name)

    if (!preview || !drafts)
      return entries

    const draftKey = `kay:draft:${name}`
    let drafted = preview.loads.get(draftKey) as Promise<Entries<Data>> | undefined

    if (!drafted) {
      preview.loads.set(draftKey, drafted = (async () => {
        const raw = raws.get(entries) ?? []
        const written = new Map<string, RawEntry>()

        for (const draft of drafts) {
          const slug = localized ? `${draft.locale}/${draft.slug}` : draft.slug

          written.set(slug, { ...raw.find(entry => entry.slug === slug) ?? { file: `${name}/${slug}` }, slug, data: draft.data, lines: {}, ...draft.compiled })
        }

        // The drafted entries alone are decoded; the others are copied when localized, as indexing sets their translations and the collection's own are shared with every request.
        const kept = entries.list.filter(entry => !written.has(localized ? `${entry.locale}/${entry.slug}` : entry.slug))

        return indexed([...localized ? kept.map(entry => ({ ...entry })) : kept, ...decodeEach([...written.values()])])
      })())
    }

    return drafted
  }
  const loaded = async () => withDrafts(await (loader ? fromLoader : fromFolder)())
  const hidden = (entry: Entry<Data>) => draft !== undefined && !contentMode().dev && !previewing() && isDraft(draft, entry)
  // A draft translation is left out as a missing one is, the default locale's entry standing in.
  const shown = (entry: Entry<Data> | undefined) => entry !== undefined && !hidden(entry) ? entry : undefined

  return {
    [COLLECTION]: true,
    name,
    dir: loader ? undefined : name,
    loader,
    options: options as CollectionOptions<TSchema>,
    components: components as Components,
    all: async (locale) => {
      const { list, byLocale } = await loaded()
      const wanted = localized ? locale ?? localeState()?.locale : undefined

      if (wanted === undefined)
        return editableEntries(name, list.filter(entry => !hidden(entry)))

      const own = byLocale.get(wanted)
      const fallback = localeState()?.settings.defaultLocale

      return editableEntries(name, list.filter(entry => !hidden(entry) && (entry.locale === wanted || (entry.locale === fallback && shown(own?.get(entry.slug)) === undefined))))
    },
    get: async (slug, locale) => {
      const { bySlug, byLocale } = await loaded()
      const wanted = localized ? locale ?? localeState()?.locale : undefined
      const fallback = localeState()?.settings.defaultLocale

      const found = wanted === undefined ? shown(bySlug.get(slug)) : shown(byLocale.get(wanted)?.get(slug)) ?? (fallback === undefined ? undefined : shown(byLocale.get(fallback)?.get(slug)))

      return found && editableEntries(name, [found])[0]
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

// The paths the module's collections serve their feeds at, the ones written as literals.
export type FeedPathsOf<Module> = { [Name in keyof Module]: Module[Name] extends Collection<unknown, Record<string, Component<never>>, infer Path> ? string extends Path ? never : Path : never }[keyof Module]

export function isCollection(value: unknown): value is Collection<unknown> {
  return typeof value === 'object' && value !== null && COLLECTION in value
}

function toEntry<Data>(entry: RawEntry, data: Data, components: Record<string, Component<never>>, localized: boolean): Entry<Data> {
  const segments = entry.segments ?? []
  const split = entry.slug.indexOf('/')

  return {
    ...localized && { locale: entry.slug.slice(0, split) },
    slug: localized ? entry.slug.slice(split + 1) : entry.slug,
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
      markup += localLinks(segment)

      continue
    }

    const component = components[segment.component] as ((props: Record<string, unknown>) => unknown) | undefined

    if (!component)
      throw new Error(`kay: ${file} uses <${segment.component}>, which its collection's components do not name`)

    const { children } = segment
    // A self-closing tag passes no children.
    const props = children.length === 0
      ? segment.props
      : { ...segment.props, get children() {
        return render(children, components, file)
      } }

    markup += child(component(props))
  }

  return { t: markup }
}
