import type { Static, TSchema } from 'elysia'
import type { Html } from '../runtime/html'
import type { Component } from '../runtime/jsx'
import type { FeedOptions } from './feed'
import type { RawEntry } from './load'
import type { Heading, Highlighter, Segment } from './markdown'
import process from 'node:process'
import { child } from '../runtime/html'
import { loadEntries } from './load'
import { decodeEntries } from './validate'

export type { FeedItem, FeedOptions } from './feed'
export type { Heading, Highlighter } from './markdown'

export const COLLECTION = Symbol.for('kay.collection')

export interface Entry<Data> {
  // The file's path in the collection without its extension, `guides/intro` for `guides/intro.md`; an `index` file takes its folder's.
  slug: string
  data: Data
  // A Markdown entry's headings, in order, for a table of contents; empty for a data file.
  headings: Heading[]
  // Renders a Markdown entry's body, the kay components it uses included; renders nothing for a data file.
  Content: Component
  // The file, relative to the project root.
  file: string
}

export interface CollectionOptions<Schema extends TSchema> {
  // What each entry's frontmatter, or a data file's content, holds; an entry it refuses fails `kay check` and the build.
  schema: Schema
  // The kay components a Markdown entry may use, by the name it writes them with: `<Callout type="warn">`.
  components?: Record<string, Component<never>>
  // Highlights code blocks when the entries compile, at build time, such as with Shiki.
  highlight?: Highlighter
  // Entries left out everywhere but `kay dev`: from `all()`, `get()`, prerendering, the sitemap and the feed.
  draft?: (entry: Entry<Static<Schema>>) => boolean
  // The order `all()` lists entries in; by slug otherwise.
  sort?: (a: Entry<Static<Schema>>, b: Entry<Static<Schema>>) => number
  // An RSS or Atom feed of the collection, served at its path.
  feed?: FeedOptions<Static<Schema>>
}

export interface Collection<Data> {
  readonly [COLLECTION]: true
  // The folder, relative to the project root.
  readonly dir: string
  readonly options: CollectionOptions<TSchema>
  // Every entry, in the collection's order.
  all: () => Promise<Entry<Data>[]>
  // The entry with that slug, or undefined.
  get: (slug: string) => Promise<Entry<Data> | undefined>
}

// A folder of Markdown files, or of JSON and YAML data files, read against a schema: `collection('src/content/posts', { schema })`.
// Entries compile once, each cached by its content, so a change recompiles only that entry; `kay build` compiles them all ahead for production.
export function collection<Schema extends TSchema>(dir: string, options: CollectionOptions<Schema>): Collection<Static<Schema>> {
  type Data = Static<Schema>
  let loading: Promise<{ list: Entry<Data>[], bySlug: Map<string, Entry<Data>> }> | undefined
  const components = options.components ?? {}

  const load = async () => {
    const raw = await loadEntries(dir, options.highlight)
    const decoded = decodeEntries(raw, options.schema, components).map(({ entry, data }) => toEntry<Data>(entry, data as Data, components))
    const { draft } = options
    const entries = draft && process.env.NODE_ENV !== 'development' ? decoded.filter(entry => !draft(entry)) : decoded

    entries.sort(options.sort ?? ((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))

    return { list: entries, bySlug: new Map(entries.map(entry => [entry.slug, entry])) }
  }

  const loaded = async () => {
    loading ??= load()

    try {
      return await loading
    }
    // A collection that failed to load tries again on the next call, once its files are fixed.
    catch (error) {
      loading = undefined

      throw error
    }
  }

  return {
    [COLLECTION]: true,
    dir,
    options: options as unknown as CollectionOptions<TSchema>,
    all: async () => [...(await loaded()).list],
    get: async slug => (await loaded()).bySlug.get(slug),
  }
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
    Content: () => render(segments, components, entry.file) as never,
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
