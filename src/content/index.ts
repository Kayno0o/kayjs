import type { Static, TSchema } from 'elysia'
import type { CacheStore } from '../runtime/cache'
import type { Duration } from '../runtime/duration'
import type { Component } from '../runtime/jsx'
import type { Html } from '../runtime/rendered'
import type { FeedOptions } from './feed'
import type { RawEntry } from './load'
import type { Heading, Highlighter, Segment } from './markdown'
import type { Carried, Migration } from './migrate'
import type { ContentProblem } from './validate'
import { KayError } from '../compiler/errors'
import { cached, invalidate, noteLive, noteRead, onKeysInvalidated } from '../runtime/cache'
import { durationSeconds } from '../runtime/duration'
import { noteEndedEntry } from '../runtime/ended-entry'
import { editableEntries } from '../runtime/fields'
import { child, html, localLinks } from '../runtime/html'
import { localeState } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { previewing, previewState } from '../runtime/preview'
import { checkPublishField, isDraft, publishTime } from './drafts'
import { sizedImages } from './images'
import { contentKey, contentMode, loadEntries, markdownOf, translationKey } from './load'
import { compileMarkdown, countWords, MarkdownError } from './markdown'
import { hasSteps, migrateEntries, migrateLoaded, withMigrationHint, writeBack } from './migrate'
import { ContentError, decodeEntries, isBlockItem, validEntries } from './validate'

export type { CollectionInfo, DataValue, EntryFile, EntryFilter, EntryPath, FieldHint, FieldInputOptions, FieldKind, ImageFieldOptions, JsonSchema, SourceEntry, TranslationIndex, UploadFieldOptions, WrittenEntry } from './edit'
export { blocks, collectionInfo, collectionLoader, collections, colorField, customField, entries, entryFile, entryPage, entrySource, fieldInput, fileField, findIcons, geoField, iconField, imageField, linkField, markdownField, moneyField, reference, removeEntry, repositoryRoot, saveEntries, saveEntry, tagsField, translations, unique, untranslated } from './edit'
export type { FeedItem, FeedOptions } from './feed'
export type { Heading, Highlighter, RenderedMarkdown } from './markdown'
export { bodyHtml, highlightCode, MarkdownError, renderMarkdown } from './markdown'
export type { Migration } from './migrate'
export { convertField, renameField, setField } from './migrate'
export type { Page, Paginated } from './paginate'
export { isPaginated, paginate } from './paginate'

export const COLLECTION = Symbol.for('kay.collection')
// The dates the collection's entries are published at, which the server watches to refresh the pages that read it.
export const PUBLISH_TIMES = Symbol.for('kay.publishTimes')
// Never set: it only carries a feed's path in the collection's type, for `kay check` to count it as served.
declare const FEED_PATH: unique symbol
export { contentKey }
// Loaded entries are kept until `invalidate()` or a restart unless the loader sets a `ttl`: about thirty years.
const FOREVER = 1e9

export interface Entry<Data> {
  // The file's path in the collection without its extension, `guides/intro` for `guides/intro.md`; an `index` file takes its folder's.
  slug: string
  data: Data
  // A Markdown entry's headings, in order, for a table of contents; empty for a data file.
  headings: Heading[]
  // The words of a Markdown entry's rendered text, none for a data file; see `readingTime`.
  words: number
  // The minutes a Markdown entry takes to read at `readingSpeed` words a minute, 230 by default, at least 1, 0 for a data file.
  readingTime: number
  // Renders a Markdown entry's body, the kay components it uses included; renders nothing for a data file.
  Content: Component
  // The file, relative to the project root; a loaded entry's collection name and slug, `posts/hello`.
  file: string
  // In a localized collection, the locale whose folder holds the entry, the default one's when it stands in for a locale lacking it.
  locale?: string | undefined
  // In a localized collection, the locales with an entry of this slug, or of the same `translationKey` field when the entries set one, its own included.
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
// An entry's data as a CMS sends it and a loader stores it: JSON, so a date is its text.
export type Stored<Data> = Data extends Date ? string : Data extends readonly (infer Item)[] ? Stored<Item>[] : Data extends object ? { [Field in keyof Data]: Stored<Data[Field]> } : Data

// `Data` is what `save` is handed: the collection's schema typed as stored, see `Stored`.
export interface ContentLoader<Data = unknown> {
  // Names the collection in messages and keys its cache.
  name: string
  // Every entry, drafts included; `preview` is true for a visitor in preview mode and in `kay dev`, for a CMS that serves drafts apart.
  load: (context: { preview: boolean }) => LoadedEntry[] | Promise<LoadedEntry[]>
  // How many entries `load` gives, for a source able to say without giving them: a CMS screen listing collections asks it instead of running `load`.
  count?: ((context: { preview: boolean }) => number | Promise<number>) | undefined
  // Whether the entries hold a Markdown `body` rather than `html`, which a CMS editing them reads off `count` alone; true when left out.
  body?: boolean | undefined
  // The entry of that place, its slug with the locale before it, `fr/launch`, in a localized collection, or undefined for none: a CMS editing one entry asks it instead of running `load` for all.
  get?: ((place: string, context: { preview: boolean }) => LoadedEntry | undefined | Promise<LoadedEntry | undefined>) | undefined
  // How long the entries are served before the next read refreshes them in the background, as `cached` does; without it, until `invalidate()` or a restart.
  ttl?: Duration | undefined
  // Keeps the entries across restarts and processes, as `cached` does.
  store?: CacheStore | undefined
  // Writes an entry a CMS saved, new or changed, once its collection accepts it: what `saveEntry` from `kay/content` hands on. `data` is typed from the collection's `schema`, which kay has checked it against, with each missing default filled in and a date as its text. `create` is true for an entry the CMS creates: throw when it exists, or another process's new entry is overwritten.
  save?: ((entry: { slug: string, locale?: string | undefined, data: Data, body?: string | undefined, create?: true }) => void | Promise<void>) | undefined
  // Writes several entries a CMS saved together, such as the two a move swaps, all or none: what `saveEntries` from `kay/content` hands on, in a transaction for a database. Without it they go to `save` one at a time, so a failure in between leaves the earlier ones written.
  saveMany?: ((entries: { slug: string, locale?: string | undefined, data: Data, body?: string | undefined }[]) => void | Promise<void>) | undefined
  // Deletes an entry, which `removeEntry` from `kay/content` asks.
  remove?: ((entry: { slug: string, locale?: string | undefined }) => void | Promise<void>) | undefined
  // A hidden collection in the same store, named by what a CMS keeps in it (`history`, `trash`), whose entries never show in this one: kayjs-cms keeps an entry's revisions and its deleted entries there, so a loader without it has no history.
  sibling?: ((kind: string) => ContentLoader) | undefined
}

// The fields of the data holding a number, which `order` may name.
type NumberField<Data> = { [Name in keyof Data]-?: Data[Name] extends number | undefined ? Name : never }[keyof Data] & string

// The fields of the data holding a boolean, which `draft` may name.
type BooleanField<Data> = { [Name in keyof Data]-?: Data[Name] extends boolean | undefined ? Name : never }[keyof Data] & string

// The fields of the data holding a date, which `publishAt` may name.
type DateField<Data> = { [Name in keyof Data]-?: Data[Name] extends Date | null | undefined ? Name : never }[keyof Data] & string

export interface CollectionOptions<Schema extends TSchema> {
  // The name a CMS screen titles the collection with, `Produits`; the export's name, humanized, when left out. The name still keeps the URLs, the markers and the upload folder.
  title?: string | undefined
  // A line telling an editor what the collection holds, which a CMS shows above its entries and its form.
  description?: string | undefined
  // What each entry's frontmatter, or a data file's content, holds; an entry it refuses fails `kay check` and the build.
  schema: Schema
  // Steps carrying stored entries over when the schema changes, each taking an entry's data in the shape it had and giving the new one: `[renameField('cost', 'price'), convertField('price', Number)]`. They run, in order, only on an entry the schema refuses, until it accepts it; a loader's entry that changed is written back through its `save` once, a folder's entry is migrated as read, the file kept until a CMS saves it. Write a step to leave data in the new shape as it is.
  migrations?: Migration[] | undefined
  // The kay components a Markdown entry may use, by the name it writes them with: `<Callout type="warn">`.
  components?: Record<string, Component<never>> | undefined
  // Highlights code blocks when the entries compile, at build time, such as with Shiki; `kay.config.ts`'s `markdown.highlight` unless set here.
  highlight?: Highlighter | undefined
  // Whether a heading links to itself, `kay.config.ts`'s `markdown.headingLinks` unless set here; on by default.
  headingLinks?: boolean | undefined
  // Words a minute `readingTime` counts at, `kay.config.ts`'s `markdown.readingSpeed` unless set here; 230 by default.
  readingSpeed?: number | undefined
  // The `sizes` of the relative images in the entries' Markdown, `kay.config.ts`'s `markdown.imageSizes` unless set here; `100vw` by default. An image's own `sizes` attribute wins.
  imageSizes?: string | undefined
  // Entries left out everywhere but `kay dev` and preview mode: from `all()`, `get()`, prerendering, the sitemap and the feed. A boolean field's name, `'draft'`, leaves out those where it is true, which a CMS then reads and writes.
  draft?: ((entry: Entry<Static<Schema>>) => boolean) | BooleanField<Static<Schema>> | undefined
  // A date field, `'publishAt'`, holding an entry back as a draft is until that time and showing it by itself then: in `all()`, `get()`, the pages prerendered from it, the sitemap and the feed. A date alone is 00:00 UTC, a date with an offset is that instant; an entry without one is published. A draft stays one whatever its date.
  publishAt?: DateField<Static<Schema>> | undefined
  // A date field, `'endsAt'`, taking an entry down as a draft is from that time on, by itself: out of `all()`, `get()`, the pages prerendered from it, the sitemap and the feed, the page of its URL rendering again and answering 410 Gone when its code calls `ctx.notFound()` after `get()` found nothing for the ended entry, or what the app chose otherwise (a redirect); a redirect from the path wins over the 410. An entry without one never ends; `kay dev` and preview mode keep showing it.
  unpublishAt?: DateField<Static<Schema>> | undefined
  // A number field the entries are ordered by, ascending, those without it last: `all()` lists them so unless `sort` says otherwise, and a CMS moves an entry up or down by writing it.
  order?: NumberField<Static<Schema>> | undefined
  // The order `all()` lists entries in; by `order`, else by slug.
  sort?: ((a: Entry<Static<Schema>>, b: Entry<Static<Schema>>) => number) | undefined
  // An RSS or Atom feed of the collection, served at its path.
  feed?: FeedOptions<Static<Schema>> | undefined
  // Each entry sits in a folder named after its locale, `fr/hello.md`, a translation sharing its slug: `all()` and `get()` read the request's locale, the default locale's entry standing in for one it lacks, and the feed is served once per locale.
  localized?: boolean | undefined
  // The path of the page showing an entry, under the base, which a CMS opens it on; by default the page whose `prerender` lists the collection.
  url?: ((entry: { slug: string, locale?: string | undefined, data: Static<Schema> }) => string) | undefined
  // Every open page that read the collection follows it: once `invalidate()` drops its entries, a CMS saving or removing one included, the page shows what `all()` and `get()` give now. Needs the read in a page's server fence or a layout's; a static export of such a page fails.
  live?: boolean | undefined
  // The collection holds one entry, such as a home page's texts: a CMS opens its form straight from the content list, with no row, no New entry and no Delete, titled with the collection's `title`. Its entry is the collection's only one, `index` when it is first written, and `one()` reads it. Not for a `localized` collection.
  single?: boolean | undefined
  // For a `single` collection, the data it holds until its entry is written: a CMS opens the form filled with it, the first save writes it, and `one()` gives it while no entry exists.
  seed?: Static<Schema> | undefined
}

export interface Collection<Data, Components extends Record<string, Component<never>> = Record<string, Component<never>>, FeedPath extends string = string> {
  readonly [COLLECTION]: true
  readonly [FEED_PATH]?: FeedPath
  // The dates `publishAt` and `unpublishAt` read from the entries, in order and once each.
  readonly [PUBLISH_TIMES]: () => Promise<number[]>
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
  // In a localized collection, the entry of that locale paired with this one by slug or `translationKey`, whatever its own slug, or undefined when the locale has none: for a language switcher, with no fallback to the default locale.
  translation: (entry: { slug: string, data: unknown }, locale: string) => Promise<Entry<Data> | undefined>
  // Loads the entries afresh on the next read: for a webhook a CMS calls once an entry changed. A loader's `store` passes it to every process sharing it.
  invalidate: () => void
  // For a `single` collection, its entry's data, else `fallback`, else the `seed`; undefined with none of them. Throws for a collection not declared `single`.
  one: <Fallback extends Data | undefined = undefined>(fallback?: Fallback) => Promise<Fallback extends undefined ? Data | undefined : Data>
}

interface Entries<Data> {
  list: Entry<Data>[]
  bySlug: Map<string, Entry<Data>>
  // A localized collection's entries by locale, then slug.
  byLocale: Map<string, Map<string, Entry<Data>>>
  // A localized collection's entries by locale, then the key pairing them with their translations.
  paired: Map<string, Map<string, Entry<Data>>>
}

// A folder of Markdown files, or of JSON and YAML data files, read against a schema: `collection('src/content/posts', { schema })`; or the entries a loader gives, `collection({ name: 'posts', load }, { schema })`.
// File entries compile once, each cached by its content, so a change recompiles only that entry; `kay build` compiles them all ahead for production. Loaded entries are read when first asked for, and kept as `cached` keeps a value.
export function collection<Schema extends TSchema, Components extends Record<string, Component<never>> = Record<never, never>, const FeedPath extends string = string>(source: string | ContentLoader<Stored<Static<Schema>>>, options: CollectionOptions<Schema> & { components?: Components, feed?: { path: FeedPath } | undefined }): Collection<Static<Schema>, Components, FeedPath> {
  type Data = Static<Schema>
  let loading: Promise<Entries<Data>> | undefined
  const components = options.components ?? {}
  // Its `save` is typed from the schema for the app; kay hands it data it checked against that schema.
  const loader = typeof source === 'string' ? undefined : source as ContentLoader
  const name = typeof source === 'string' ? source : source.name
  const key = contentKey(name)
  const decoded = new WeakMap<RawEntry[], Entries<Data>>()
  const raws = new WeakMap<Entries<Data>, RawEntry[]>()
  const { draft, localized = false, publishAt, unpublishAt } = options

  if (publishAt !== undefined)
    checkPublishField(name, options.schema, publishAt, 'publishAt')

  if (unpublishAt !== undefined)
    checkPublishField(name, options.schema, unpublishAt, 'unpublishAt')

  if (options.single && localized)
    throw new KayError('config-invalid', `kay: the collection ${name} is both \`single\` and \`localized\`; a single entry has no translations, so leave one out`)

  if (options.seed !== undefined && !options.single)
    throw new KayError('config-invalid', `kay: the collection ${name} has a \`seed\` but is not \`single\`; a seed is the data of its only entry`)

  const migrations = options.migrations
  const decodeEach = (raw: RawEntry[]) => {
    const { readingSpeed, imageSizes } = markdownOf(options)

    try {
      return decodeEntries(raw, options.schema, components, localized).map(({ entry, data }) => toEntry<Data>(entry, data as Data, components, localized, readingSpeed, imageSizes))
    }
    catch (error) {
      throw typeof source === 'string' ? withMigrationHint(error, migrations) : error
    }
  }

  // Sorts the entries and maps them by slug and locale, setting each one's translations.
  const indexed = (entries: Entry<Data>[]): Entries<Data> => {
    const byLocale = new Map<string, Map<string, Entry<Data>>>()
    const paired = new Map<string, Map<string, Entry<Data>>>()

    entries.sort(options.sort ?? (options.order === undefined ? bySlugThenLocale : byField(options.order)))

    for (const entry of entries) {
      if (entry.locale === undefined)
        continue

      const slugs = byLocale.get(entry.locale) ?? new Map<string, Entry<Data>>()

      byLocale.set(entry.locale, slugs.set(entry.slug, entry))
      paired.set(entry.locale, (paired.get(entry.locale) ?? new Map<string, Entry<Data>>()).set(translationKey(entry), entry))
    }

    for (const entry of entries) {
      if (localized)
        entry.translations = [...paired].filter(([, keys]) => keys.has(translationKey(entry))).map(([locale]) => locale).sort()
    }

    return { list: entries, bySlug: new Map(entries.map(entry => [entry.slug, entry])), byLocale, paired }
  }

  const decode = (raw: RawEntry[]): Entries<Data> => {
    const result = indexed(decodeEach(raw))

    raws.set(result, raw)

    return result
  }

  // What the loader gives, migrated and compiled; an entry the schema refuses is left out and reported, so one stale row does not hide the others. The result is kept as any load's is, so an entry an editor fixes shows from that save's `invalidate()`, or at the next load past `ttl`.
  const fetchLoaded = async (preview: boolean) => {
    const { raw, carried } = await compileLoaded(loader!, preview, markdownOf(options), options as CollectionOptions<TSchema>)
    const { entries, problems } = validEntries(raw, options.schema, components, localized)

    // Only an entry that proved valid is written back.
    const kept = new Set(entries.map(entry => entry.slug))

    await writeBack(loader!, carried.filter(({ entry }) => kept.has(entry.slug)), localized, preview)

    if (problems.length > 0) {
      const left = new Set(problems.map(problem => problem.file)).size

      kayLog('warn', `kay: ${left === 1 ? 'a stored entry' : `${left} stored entries`} of ${name} ${left === 1 ? 'does' : 'do'} not match its schema and ${left === 1 ? 'is' : 'are'} left out until fixed, in the CMS${hasSteps(migrations) ? '' : ' or with `migrations` on the collection'}\n${problems.map(problem => `  ${problem.file} ${problem.message}`).join('\n')}`)
    }

    return entries
  }

  const fromFolder = async () => {
    loading ??= (async () => decode(migrateEntries(name, await loadEntries(source as string, { ...markdownOf(options), localized }), options.schema, migrations)))()

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
        preview.loads.set(key, loads = (async () => decode(await fetchLoaded(true)))())

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
      preview.loads.set(draftKey, drafted = Promise.try(() => {
        const raw = raws.get(entries) ?? []
        const written = new Map<string, RawEntry>()

        for (const draft of drafts) {
          const slug = localized ? `${draft.locale}/${draft.slug}` : draft.slug

          // A second draft of an entry goes over the first.
          written.set(slug, { ...written.get(slug) ?? raw.find(entry => entry.slug === slug) ?? { file: `${name}/${slug}` }, slug, data: draft.data, lines: {}, ...draft.compiled })
        }

        // The drafted entries alone are decoded; the others are copied when localized, as indexing sets their translations and the collection's own are shared with every request.
        const kept = entries.list.filter(entry => !written.has(localized ? `${entry.locale}/${entry.slug}` : entry.slug))

        return indexed([...localized ? kept.map(entry => ({ ...entry })) : kept, ...decodeEach([...written.values()])])
      }))
    }

    return drafted
  }

  // Whichever process invalidates it, this one loads the entries afresh. The listener holds the collection weakly, so one a reload replaced is let go of, and leaves the listeners at its next invalidation.
  const reset = () => {
    loading = undefined
  }
  const weakReset = new WeakRef(reset)
  const stop = onKeysInvalidated((_, dropped) => {
    const target = weakReset.deref()

    if (!target)
      stop()
    else if (dropped(key))
      target()

    return []
  })
  // A page reading the entries is refreshed when `invalidate()` drops them.
  const loaded = async () => {
    noteRead(key)

    if (options.live)
      noteLive(key)

    return withDrafts(await (loader ? fromLoader : fromFolder)())
  }
  const notYet = (entry: Entry<Data>) => {
    const live = publishAt === undefined ? undefined : publishTime(publishAt, entry)

    return live !== undefined && live > Date.now()
  }
  const over = (entry: Entry<Data>) => {
    const down = unpublishAt === undefined ? undefined : publishTime(unpublishAt, entry)

    return down !== undefined && down <= Date.now()
  }
  const scheduled = (entry: Entry<Data>) => notYet(entry) || over(entry)
  // Whether the end date passed, the only reason that makes the entry's URL gone for good rather than not found: a draft, or an entry not yet published, may come back.
  const ended = (entry: Entry<Data> | undefined) => entry !== undefined && !(draft !== undefined && isDraft(draft, entry)) && over(entry) && !notYet(entry)
  const hidden = (entry: Entry<Data>) => (draft !== undefined || publishAt !== undefined || unpublishAt !== undefined) && !contentMode().dev && !previewing() && ((draft !== undefined && isDraft(draft, entry)) || scheduled(entry))
  const blockItem = (data: unknown, path: string[]) => isBlockItem(options.schema, data, path)
  // A draft translation is left out as a missing one is, the default locale's entry standing in.
  const shown = (entry: Entry<Data> | undefined) => entry !== undefined && !hidden(entry) ? entry : undefined

  return {
    [COLLECTION]: true,
    [PUBLISH_TIMES]: async () => {
      if (publishAt === undefined && unpublishAt === undefined)
        return []

      const fields = [publishAt, unpublishAt].filter(field => field !== undefined)
      const times = (await (loader ? fromLoader : fromFolder)()).list.flatMap(entry => fields.map(field => publishTime(field, entry)))

      return [...new Set(times.filter(time => time !== undefined))].toSorted((a, b) => a - b)
    },
    name,
    dir: loader ? undefined : name,
    loader,
    options: options as CollectionOptions<TSchema>,
    components: components as Components,
    all: async (locale) => {
      const { list, paired } = await loaded()
      const wanted = localized ? locale ?? localeState()?.locale : undefined

      if (wanted === undefined)
        return editableEntries(name, list.filter(entry => !hidden(entry)), blockItem)

      const own = paired.get(wanted)
      const fallback = localeState()?.settings.defaultLocale

      return editableEntries(name, list.filter(entry => !hidden(entry) && (entry.locale === wanted || (entry.locale === fallback && shown(own?.get(translationKey(entry))) === undefined))), blockItem)
    },
    get: async (slug, locale) => {
      const { bySlug, byLocale } = await loaded()
      const wanted = localized ? locale ?? localeState()?.locale : undefined
      const fallback = localeState()?.settings.defaultLocale

      const found = wanted === undefined ? shown(bySlug.get(slug)) : shown(byLocale.get(wanted)?.get(slug)) ?? (fallback === undefined ? undefined : shown(byLocale.get(fallback)?.get(slug)))

      if (found === undefined && !contentMode().dev && !previewing() && (wanted === undefined ? [bySlug.get(slug)] : [byLocale.get(wanted)?.get(slug), fallback === undefined ? undefined : byLocale.get(fallback)?.get(slug)]).some(ended))
        noteEndedEntry()

      return found && editableEntries(name, [found], blockItem)[0]
    },
    translation: async (entry, locale) => {
      const found = shown((await loaded()).paired.get(locale)?.get(translationKey(entry)))

      return found && editableEntries(name, [found], blockItem)[0]
    },
    one: async <Fallback extends Data | undefined = undefined>(fallback?: Fallback) => {
      if (!options.single)
        throw new KayError('content-api-misuse', `kay: ${name}.one() reads a \`single\` collection; declare it with \`single: true\`, or use all() and get()`)

      const { list } = await loaded()
      const entry = list.find(candidate => !hidden(candidate))

      return entry ? editableEntries(name, [entry], blockItem)[0]!.data : fallback ?? options.seed
    },
    // Holds `reset`, which the listener only holds weakly.
    invalidate: () => {
      reset()
      invalidate(key)
    },
  }
}

// What a loader gives, compiled as files are: a Markdown body into segments and headings, HTML as one segment; two entries sharing a slug fail the collection.
async function compileLoaded(loader: ContentLoader, preview: boolean, markdown: ReturnType<typeof markdownOf>, options: CollectionOptions<TSchema>): Promise<{ raw: RawEntry[], carried: Carried[] }> {
  let given: unknown = await loader.load({ preview })

  if (!Array.isArray(given))
    throw new KayError('loader-result', `kay: the collection ${loader.name}'s load gave ${given === null ? 'null' : typeof given}, where it gives an array of entries`)

  const migrated = migrateLoaded(loader.name, given as unknown[], options.schema, options.migrations)

  given = migrated.items

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
      const fromHtml = typeof html === 'string' ? { segments: [html], headings: [], words: countWords(html) } : undefined
      const compiled = typeof body === 'string' ? await compileMarkdown(body, 1, markdown.highlight, markdown.headingLinks) : fromHtml

      entries.push({ slug, file, data, lines: {}, segments: compiled?.segments, headings: compiled?.headings, words: compiled?.words })
    }
    catch (error) {
      problems.push({ file, line: error instanceof MarkdownError ? error.line : 1, message: error instanceof Error ? error.message : String(error) })
    }
  }

  if (problems.length > 0)
    throw new ContentError(problems)

  return { raw: entries, carried: migrated.carried }
}

// The paths the module's collections serve their feeds at, the ones written as literals.
export type FeedPathsOf<Module> = { [Name in keyof Module]: Module[Name] extends Collection<unknown, Record<string, Component<never>>, infer Path> ? string extends Path ? never : Path : never }[keyof Module]

export function isCollection(value: unknown): value is Collection<unknown> {
  return typeof value === 'object' && value !== null && COLLECTION in value
}

function bySlugThenLocale(a: { slug: string, locale?: string | undefined }, b: { slug: string, locale?: string | undefined }): number {
  if (a.slug !== b.slug)
    return a.slug < b.slug ? -1 : 1

  return a.locale! < b.locale! ? -1 : 1
}

function byField(field: string): (a: Entry<unknown>, b: Entry<unknown>) => number {
  const numberAt = (entry: Entry<unknown>) => {
    const value = (entry.data as Record<string, unknown> | undefined)?.[field]

    return typeof value === 'number' && Number.isFinite(value) ? value : Infinity
  }

  return (a, b) => {
    const [first, second] = [numberAt(a), numberAt(b)]

    if (first === second)
      return bySlugThenLocale(a, b)

    return first < second ? -1 : 1
  }
}

function toEntry<Data>(entry: RawEntry, data: Data, components: Record<string, Component<never>>, localized: boolean, readingSpeed: number, imageSizes: string | undefined): Entry<Data> {
  const segments = entry.segments ?? []
  const split = entry.slug.indexOf('/')
  const words = entry.words ?? 0

  return {
    ...localized && { locale: entry.slug.slice(0, split) },
    slug: localized ? entry.slug.slice(split + 1) : entry.slug,
    data,
    headings: entry.headings ?? [],
    words,
    readingTime: words === 0 ? 0 : Math.max(1, Math.round(words / readingSpeed)),
    Content: () => render(segments, components, entry.file, imageSizes),
    file: entry.file,
  }
}

// The markup of the segments, each component called as a template calls it: its props, and what it wraps as `children`.
function render(segments: Segment[], components: Record<string, Component<never>>, file: string, imageSizes: string | undefined): Html {
  let markup = ''

  for (const segment of segments) {
    if (typeof segment === 'string') {
      markup += sizedImages(localLinks(segment), imageSizes)

      continue
    }

    const component = components[segment.component] as ((props: Record<string, unknown>) => unknown) | undefined

    if (!component)
      throw new KayError('content-invalid', `kay: ${file} uses <${segment.component}>, which its collection's components do not name`)

    const { children } = segment
    // A self-closing tag passes no children.
    const props = children.length === 0
      ? segment.props
      : { ...segment.props, get children() {
        return render(children, components, file, imageSizes)
      } }

    markup += child(component(props))
  }

  return html(markup)
}
