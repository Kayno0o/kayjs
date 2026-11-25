// @kayjs/content — Zero-dependency Bun-native Markdown collections, nested YAML frontmatter (Bun.YAML),
// Shiki/custom highlight hook, MDX-lite embedded TSX components, localized collections, TOC, and RSS (`0 KB` client JS).

import type { ActiveI18nConfig, KayPlugin, StandardSchemaV1 } from '@kayjs/kay/server'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { definePlugin, formatIssuePath, getAppContext, I18N_CONFIG_SERVICE, validateSchemaSync } from '@kayjs/kay/server'

import { escAttr } from '@kayjs/kay/ssr'
import { renderMarkdown } from './markdown'

export { renderMarkdown }
const COLLECTION_VERSION_KEY = Symbol.for('kay.content.collectionVersion')
const COLLECTION_VALIDATE_KEY = Symbol.for('kay.content.validateAll')
const COLLECTION_DIR_FOR_ROOT_KEY = Symbol.for('kay.content.dirForRoot')

interface InternalCollection extends Collection<unknown> {
  [COLLECTION_VERSION_KEY]?: () => number
  [COLLECTION_VALIDATE_KEY]?: (root: string) => string[]
  [COLLECTION_DIR_FOR_ROOT_KEY]?: (root?: string) => string
}

const registeredCollections = new Set<InternalCollection>()

export interface ContentHeading {
  level: number
  id: string
  text: string
}

export interface RenderedMarkdown {
  readonly html: string
  readonly headings: readonly ContentHeading[]
  readonly wordCount: number
  readonly readingMinutes: number
}

export interface ContentEntry<TData = Record<string, unknown>> {
  readonly slug: string
  readonly locale?: string | undefined
  readonly file: string
  readonly data: TData
  readonly body: string
  readonly html: string
  readonly headings: readonly ContentHeading[]
  readonly wordCount: number
  readonly readingMinutes: number
  /** Lazily resolves async collection renderers (`highlight`, `components`) and renders Markdown once. */
  render(): Promise<RenderedMarkdown>
}

export type MarkdownComponent = (props: never) => unknown
export type CodeHighlighter = (code: string, language: string | undefined) => string

export interface MarkdownImageResult {
  src: string
  srcset?: string | undefined
  avifSrcset?: string | undefined
  sizes?: string | undefined
  width?: number | undefined
  height?: number | undefined
  loading?: 'lazy' | 'eager' | undefined
}

export type MarkdownImageResolver = (src: string, file: string | undefined) => MarkdownImageResult | string | undefined

export interface CollectionRenderConfig {
  /** Custom syntax highlighter for fenced code blocks (e.g. Shiki). */
  highlight?: CodeHighlighter | undefined
  /** Embedded Kay TSX components usable directly inside Markdown (`<Note>`, `<BarChart rows={[...]} />`). */
  components?: Record<string, MarkdownComponent> | undefined
  /** Wrap h2-h6 headings in self-referencing `<a href="#id">` links. */
  headingLinks?: boolean | undefined
  /** Optional image resolver (set to `false` to disable automatic `@kayjs/images` optimization). */
  resolveImage?: MarkdownImageResolver | false | undefined
  /** Opt out of default Markdown HTML sanitization for fully trusted content (default: false). */
  trusted?: boolean | undefined
}

export interface RenderMarkdownOptions {
  highlight?: CodeHighlighter | undefined
  components?: Record<string, MarkdownComponent> | undefined
  /** Wrap h2-h6 headings in self-referencing `<a href="#id">` links. */
  headingLinks?: boolean | undefined
  /** Active locale passed into embedded components as `props.locale`. */
  locale?: string | undefined
  /** Optional image resolver for rewriting `<img src="...">` (defaults to auto-wired `@kayjs/images` when active; `false` disables). */
  resolveImage?: MarkdownImageResolver | false | undefined
  /** Source file path passed to `resolveImage`. */
  file?: string | undefined
  /** Opt out of default Markdown HTML sanitization for fully trusted content (default: false). */
  trusted?: boolean | undefined
}

export interface CollectionOptions<TData = Record<string, unknown>> {
  /** Directory containing `.md` / `.markdown` files (or `<locale>/*.md` when `localized: true`). */
  dir: string
  /** When true, reads `<dir>/<locale>/<slug>.md` and filters queries by locale. */
  localized?: boolean | undefined
  /** Default locale when `localized: true` and no locale is passed (default: 'en'). */
  defaultLocale?: string | undefined
  /** Optional Standard Schema (Zod, Valibot, ArkType, custom) to validate frontmatter. */
  schema?: StandardSchemaV1<unknown, TData> | undefined
  /** Custom syntax highlighter for fenced code blocks (e.g. Shiki). */
  highlight?: CodeHighlighter | undefined
  /** Embedded Kay TSX components usable directly inside Markdown (`<Note>`, `<BarChart rows={[...]} />`). */
  components?: Record<string, MarkdownComponent> | undefined
  /** Wrap h2-h6 headings in self-referencing `<a href="#id">` links. */
  headingLinks?: boolean | undefined
  /** Optional image resolver for rewriting Markdown images (defaults to auto-wired `@kayjs/images`; `false` disables). */
  resolveImage?: MarkdownImageResolver | false | undefined
  /** Opt out of default Markdown HTML sanitization for fully trusted collections (default: false). */
  trusted?: boolean | undefined
  /** Lazy renderer loader (`async () => ({ highlight, components })`) so config/index/RSS never load Shiki or TSX components. */
  render?: (() => CollectionRenderConfig | Promise<CollectionRenderConfig>) | undefined
  /** Include entries with `draft: true` (default: false). */
  includeDrafts?: boolean | undefined
  /** Custom comparator for `all()` (defaults to newest `date` first, then alphabetical `slug`). */
  sort?: ((a: ContentEntry<TData>, b: ContentEntry<TData>) => number) | undefined
}

export interface Collection<TData = Record<string, unknown>> {
  readonly dir: string
  all(locale?: string): ContentEntry<TData>[]
  get(slug: string, locale?: string): ContentEntry<TData> | undefined
  byTag(tag: string, locale?: string): ContentEntry<TData>[]
  /** Returns URL paths for `export const prerender = true; export const paths = () => col.paths('/blog')`. */
  paths(prefix?: string, locale?: string): string[]
  clearCache(): void
}

/** Parses full nested YAML frontmatter using Bun's native Zig `Bun.YAML.parse`. */
export function parseFrontmatter(source: string): { data: Record<string, unknown>, body: string } {
  const normalized = source.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n'))
    return { data: {}, body: normalized }

  const end = normalized.indexOf('\n---', 4)
  if (end === -1)
    return { data: {}, body: normalized }

  const rawYaml = normalized.slice(4, end)
  const restStart = normalized.indexOf('\n', end + 4)
  const body = restStart === -1 ? '' : normalized.slice(restStart + 1)

  const parsed = rawYaml.trim() === '' ? {} : Bun.YAML.parse(rawYaml)
  const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
  return { data, body }
}

function resolveCollectionDir(dir: string, explicitRoot?: string): string {
  if (isAbsolute(dir))
    return dir
  const kayRoot = explicitRoot ?? getAppContext()?.root
  if (typeof kayRoot === 'string' && kayRoot !== '') {
    const candidate = resolve(kayRoot, dir)
    if (existsSync(candidate))
      return candidate
  }
  return resolve(dir)
}


function isInsideOrSame(dir: string, target: string): boolean {
  const rel = relative(dir, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function walkMarkdownFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    return out
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name)
    if (ent.isDirectory())
      walkMarkdownFiles(full, out)
    else if (ent.isFile() && (ent.name.endsWith('.md') || ent.name.endsWith('.markdown')))
      out.push(full)
  }
  return out
}

function defaultSort<T>(a: ContentEntry<T>, b: ContentEntry<T>): number {
  const ad = (a.data as Record<string, unknown>).date
  const bd = (b.data as Record<string, unknown>).date
  const at = ad instanceof Date ? ad.getTime() : (typeof ad === 'string' || typeof ad === 'number' ? Date.parse(String(ad)) : Number.NaN)
  const bt = bd instanceof Date ? bd.getTime() : (typeof bd === 'string' || typeof bd === 'number' ? Date.parse(String(bd)) : Number.NaN)
  if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt)
    return bt - at
  return a.slug.localeCompare(b.slug)
}

export interface CollectionOptionsWithSchema<TData> extends Omit<CollectionOptions<TData>, 'schema'> {
  /** Standard Schema (Zod, Valibot, ArkType, custom) validating frontmatter into `TData`. */
  schema: StandardSchemaV1<unknown, TData>
}

export interface CollectionOptionsWithoutSchema extends Omit<CollectionOptions<Record<string, unknown>>, 'schema'> {
  schema?: undefined
}

function findFrontmatterFieldLine(rawSource: string, fieldPath: string | undefined): number {
  const normalized = rawSource.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n'))
    return 1
  const end = normalized.indexOf('\n---', 4)
  if (end === -1)
    return 1
  if (!fieldPath)
    return 2
  const topKey = fieldPath.split('.')[0] ?? fieldPath
  const escaped = topKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const keyRe = new RegExp(`^\\s*${escaped}\\s*:`)
  const lines = normalized.slice(4, end).split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (keyRe.test(lines[i]!))
      return i + 2
  }
  return 2
}

function validateCollectionFiles(
  absDir: string,
  root: string,
  schema: StandardSchemaV1 | undefined,
): string[] {
  if (!existsSync(absDir))
    return []
  const errors: string[] = []
  for (const absFile of walkMarkdownFiles(absDir).sort()) {
    const rel = relative(root, absFile).replace(/\\/g, '/')
    const rawSource = readFileSync(absFile, 'utf8')
    let rawData: Record<string, unknown>
    try {
      rawData = parseFrontmatter(rawSource).data
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${rel}:1:1: error: @kayjs/content: invalid YAML frontmatter: ${msg}`)
      continue
    }
    if (schema === undefined)
      continue
    const checked = validateSchemaSync(
      schema,
      rawData,
      `@kayjs/content: async frontmatter schema is not supported (${rel})`,
    )
    if (!checked.ok) {
      for (const issue of checked.issues) {
        const path = formatIssuePath(issue)
        const line = findFrontmatterFieldLine(rawSource, path || undefined)
        errors.push(`${rel}:${line}:1: error: @kayjs/content: ${path ? `${path}: ` : ''}${issue.message}`)
      }
    }
  }
  return errors
}

function walkCollectionDefFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    return out
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.') || ent.name === 'routes')
      continue
    const full = join(dir, ent.name)
    if (ent.isDirectory())
      walkCollectionDefFiles(full, out)
    else if (ent.isFile() && ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts') && !/\.(?:test|spec)\.ts$/.test(ent.name))
      out.push(full)
  }
  return out
}

const DEFINE_COLLECTION_RE = /\bdefineCollection\s*(?:<[^>]*>)?\s*\(/

async function discoverAppCollections(root: string): Promise<void> {
  const srcDir = resolve(root, 'src')
  for (const file of walkCollectionDefFiles(srcDir)) {
    try {
      const text = readFileSync(file, 'utf8')
      if (DEFINE_COLLECTION_RE.test(text))
        await import(file)
    }
    catch {}
  }
}

export function defineCollection<TData>(options: CollectionOptionsWithSchema<TData>): Collection<TData>
export function defineCollection(options: CollectionOptionsWithoutSchema): Collection<Record<string, unknown>>
export function defineCollection<TData = Record<string, unknown>>(options: CollectionOptions<TData>): Collection<TData> {
  const getDir = () => resolveCollectionDir(options.dir)
  const includeDrafts = options.includeDrafts ?? false
  const localized = options.localized ?? false
  const getDefaultLocale = (): string =>
    options.defaultLocale ?? getAppContext()?.inject<ActiveI18nConfig>(I18N_CONFIG_SERVICE)?.defaultLocale ?? 'en'
  const baseRenderOpts: RenderMarkdownOptions = {
    highlight: options.highlight,
    components: options.components,
    headingLinks: options.headingLinks,
    resolveImage: options.resolveImage,
    trusted: options.trusted,
  }
  let resolvedRenderOpts: RenderMarkdownOptions | undefined = options.render === undefined ? baseRenderOpts : undefined
  let pendingRenderOpts: Promise<RenderMarkdownOptions> | undefined

  function mergeRenderConfig(cfg: CollectionRenderConfig): RenderMarkdownOptions {
    return {
      highlight: cfg.highlight ?? baseRenderOpts.highlight,
      components: cfg.components ?? baseRenderOpts.components,
      headingLinks: cfg.headingLinks ?? baseRenderOpts.headingLinks,
      resolveImage: cfg.resolveImage !== undefined ? cfg.resolveImage : baseRenderOpts.resolveImage,
      trusted: cfg.trusted !== undefined ? cfg.trusted : baseRenderOpts.trusted,
    }
  }

  function ensureRenderOptsSync(): RenderMarkdownOptions {
    if (resolvedRenderOpts !== undefined)
      return resolvedRenderOpts
    const loaded = options.render!()
    if (loaded instanceof Promise) {
      pendingRenderOpts ??= loaded.then((cfg) => {
        resolvedRenderOpts = mergeRenderConfig(cfg)
        return resolvedRenderOpts
      }).catch((err) => {
        pendingRenderOpts = undefined
        throw err
      })
      throw new Error(
        `@kayjs/content: collection "${options.dir}" uses an async "render" loader; call \`await entry.render()\` (e.g. in \`load()\`) before reading \`entry.html\` or \`entry.headings\`.`,
      )
    }
    resolvedRenderOpts = mergeRenderConfig(loaded)
    return resolvedRenderOpts
  }

  async function ensureRenderOptsAsync(): Promise<RenderMarkdownOptions> {
    if (resolvedRenderOpts !== undefined)
      return resolvedRenderOpts
    pendingRenderOpts ??= Promise.resolve(options.render!()).then((cfg) => {
      resolvedRenderOpts = mergeRenderConfig(cfg)
      return resolvedRenderOpts
    }).catch((err) => {
      pendingRenderOpts = undefined
      throw err
    })
    return pendingRenderOpts
  }

  const cache = new Map<string, { mtimeMs: number, entry: ContentEntry<TData> | null }>()
  const allCache = new Map<string, ContentEntry<TData>[]>()
  const slugCache = new Map<string, Map<string, ContentEntry<TData>>>()
  let cacheVersion = 0

  function isDevMode(): boolean {
    return getAppContext()?.dev ?? (process.env.KAY_DEV === '1')
  }

  function loadFile(absFile: string, baseDir: string, entryLocale?: string): ContentEntry<TData> | null {
    const dev = isDevMode()
    const cached = cache.get(absFile)
    if (!dev && cached !== undefined)
      return cached.entry

    const mtimeMs = statSync(absFile).mtimeMs
    if (cached !== undefined && cached.mtimeMs === mtimeMs)
      return cached.entry

    const rawSource = readFileSync(absFile, 'utf8')
    const { data: rawData, body } = parseFrontmatter(rawSource)
    const slug = relative(baseDir, absFile)
      .replace(/\\/g, '/')
      .replace(/\.(?:md|markdown)$/, '')
      .replace(/\/index$/, '')

    let data: TData
    if (options.schema !== undefined) {
      const checked = validateSchemaSync(
        options.schema,
        rawData,
        `@kayjs/content: async frontmatter schema is not supported (${slug})`,
      )
      if (!checked.ok) {
        const msg = checked.issues.map(i => i.message).join('; ')
        throw new Error(`@kayjs/content: invalid frontmatter in "${absFile}": ${msg}`)
      }
      data = checked.value
    }
    else {
      data = rawData as TData
    }

    if (!includeDrafts && (data as Record<string, unknown>).draft === true) {
      cache.set(absFile, { mtimeMs, entry: null })
      return null
    }

    const wordCount = body.trim().split(/\s+/).filter(Boolean).length
    const readingMinutes = Math.max(1, Math.ceil(wordCount / 220))
    let renderedCache: RenderedMarkdown | undefined
    const getRenderedSync = (): RenderedMarkdown => {
      renderedCache ??= renderMarkdown(body, { ...ensureRenderOptsSync(), locale: entryLocale, file: absFile })
      return renderedCache
    }
    const renderAsync = async (): Promise<RenderedMarkdown> => {
      if (renderedCache !== undefined)
        return renderedCache
      const opts = await ensureRenderOptsAsync()
      renderedCache ??= renderMarkdown(body, { ...opts, locale: entryLocale, file: absFile })
      return renderedCache
    }

    const entry: ContentEntry<TData> = {
      slug,
      ...(entryLocale !== undefined ? { locale: entryLocale } : {}),
      file: absFile,
      data,
      body,
      get html() {
        return getRenderedSync().html
      },
      get headings() {
        return getRenderedSync().headings
      },
      wordCount,
      readingMinutes,
      render: renderAsync,
    }
    cache.set(absFile, { mtimeMs, entry })
    return entry
  }

  // Slugs and locales usually come from URL params: a path built from them must stay inside the collection folder.
  function localeDir(absDir: string, targetLocale: string | undefined): string | undefined {
    if (targetLocale === undefined)
      return absDir
    const scanDir = resolve(absDir, targetLocale)
    return isInsideOrSame(absDir, scanDir) && scanDir !== absDir ? scanDir : undefined
  }

  function all(locale?: string): ContentEntry<TData>[] {
    const absDir = getDir()
    const targetLocale = localized ? (locale ?? getDefaultLocale()) : undefined
    const scanDir = localeDir(absDir, targetLocale)
    if (scanDir === undefined)
      return []
    const dev = isDevMode()
    if (!dev) {
      const hit = allCache.get(scanDir)
      if (hit !== undefined)
        return hit.slice()
    }
    const files = walkMarkdownFiles(scanDir)
    const entries: ContentEntry<TData>[] = []
    const bySlug = new Map<string, ContentEntry<TData>>()
    for (const f of files) {
      const entry = loadFile(f, scanDir, targetLocale)
      if (entry === null)
        continue
      entries.push(entry)
      bySlug.set(entry.slug, entry)
    }
    entries.sort(options.sort ?? defaultSort)
    if (!dev) {
      allCache.set(scanDir, entries)
      slugCache.set(scanDir, bySlug)
    }
    return entries.slice()
  }

  const col: Collection<TData> & {
    [COLLECTION_VERSION_KEY]: () => number
    [COLLECTION_VALIDATE_KEY]: (root: string) => string[]
    [COLLECTION_DIR_FOR_ROOT_KEY]: (root?: string) => string
  } = {
    get dir() {
      return getDir()
    },
    all,
    get(slug, locale) {
      const absDir = getDir()
      const clean = slug.replace(/^\/+|\/+$/g, '')
      const targetLocale = localized ? (locale ?? getDefaultLocale()) : undefined
      const scanDir = localeDir(absDir, targetLocale)
      if (scanDir === undefined || !isInsideOrSame(scanDir, resolve(scanDir, clean)))
        return undefined
      const dev = isDevMode()
      if (!dev) {
        const cachedSlug = slugCache.get(scanDir)?.get(clean)
        if (cachedSlug !== undefined)
          return cachedSlug
      }
      // O(1) direct file lookup before falling back to directory scan
      for (const candidate of [
        join(scanDir, `${clean}.md`),
        join(scanDir, `${clean}.markdown`),
        join(scanDir, clean, 'index.md'),
        join(scanDir, clean, 'index.markdown'),
      ]) {
        if (existsSync(candidate)) {
          const loaded = loadFile(candidate, scanDir, targetLocale) ?? undefined
          if (!dev && loaded !== undefined) {
            let map = slugCache.get(scanDir)
            if (map === undefined) {
              map = new Map()
              slugCache.set(scanDir, map)
            }
            map.set(clean, loaded)
          }
          return loaded
        }
      }
      return all(locale).find(e => e.slug === clean)
    },
    byTag(tag, locale) {
      const needle = tag.toLowerCase()
      return all(locale).filter((e) => {
        const tags = (e.data as Record<string, unknown>).tags
        return Array.isArray(tags) && tags.some(t => String(t).toLowerCase() === needle)
      })
    },
    paths(prefix = '', locale) {
      const base = prefix.replace(/\/$/, '')
      return all(locale).map(e => `${base}/${e.slug}`)
    },
    clearCache() {
      cache.clear()
      allCache.clear()
      slugCache.clear()
      cacheVersion++
    },
    [COLLECTION_VERSION_KEY]: () => cacheVersion,
    [COLLECTION_VALIDATE_KEY]: (root: string) => validateCollectionFiles(resolveCollectionDir(options.dir, root), root, options.schema),
    [COLLECTION_DIR_FOR_ROOT_KEY]: (root?: string) => resolveCollectionDir(options.dir, root),
  }
  registeredCollections.add(col as InternalCollection)
  return col
}

export interface RssFeedConfig<TData = Record<string, unknown>> {
  /** Public path for the RSS XML file (default: '/rss.xml'). */
  path?: string | undefined
  title: string
  description: string
  /** Public site origin; defaults to `KayConfig.site` when registered via `content()`. */
  site?: string | undefined
  collection: Collection<TData>
  locale?: string | undefined
  /** URL prefix prepended to each entry's slug (e.g. '/blog'). */
  linkPrefix?: string | undefined
  mapItem?: ((entry: ContentEntry<TData>) => {
    title: string
    description?: string | undefined
    date?: string | Date | undefined
    link?: string | undefined
  }) | undefined
}


export function renderRss<TData>(feed: RssFeedConfig<TData>): string {
  const site = (feed.site ?? getAppContext()?.site ?? '').replace(/\/$/, '')
  const prefix = (feed.linkPrefix ?? '').replace(/\/$/, '')
  const items = feed.collection.all(feed.locale).map((entry) => {
    const rawData = entry.data as Record<string, unknown>
    const mapped = feed.mapItem
      ? feed.mapItem(entry)
      : {
          title: String(rawData.title ?? entry.slug),
          description: typeof rawData.description === 'string' ? rawData.description : undefined,
          date: rawData.date as string | Date | undefined,
          link: `${site}${prefix}/${entry.slug}`,
        }
    const link = mapped.link ?? `${site}${prefix}/${entry.slug}`
    const pubDate = mapped.date ? `<pubDate>${new Date(mapped.date).toUTCString()}</pubDate>` : ''
    const desc = mapped.description ? `<description>${escAttr(mapped.description)}</description>` : ''
    return `<item><title>${escAttr(mapped.title)}</title><link>${escAttr(link)}</link><guid>${escAttr(link)}</guid>${pubDate}${desc}</item>`
  }).join('')

  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<rss version="2.0"><channel>`
    + `<title>${escAttr(feed.title)}</title>`
    + `<link>${escAttr(site)}</link>`
    + `<description>${escAttr(feed.description)}</description>`
    + items
    + `</channel></rss>`
}

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch)
    return false
  const trimmed = ifNoneMatch.trim()
  if (trimmed === '*')
    return true
  const target = etag.replace(/^W\//, '')
  return trimmed.split(',').some(part => part.trim().replace(/^W\//, '') === target)
}

export interface ContentFeed {
  readonly path?: string | undefined
  readonly title: string
  readonly description: string
  readonly site?: string | undefined
  readonly collection: Collection<unknown>
  readonly locale?: string | undefined
  readonly linkPrefix?: string | undefined
  readonly mapItem?: ((entry: ContentEntry<never>) => {
    title: string
    description?: string | undefined
    date?: string | Date | undefined
    link?: string | undefined
  }) | undefined
}

export function contentPlugin<const TDataList extends readonly unknown[] = readonly unknown[]>(options?: {
  feeds?: { [K in keyof TDataList]: RssFeedConfig<TDataList[K]> } | undefined
  collections?: readonly Collection<unknown>[] | undefined
}): KayPlugin
export function contentPlugin(options: { feeds?: readonly ContentFeed[] | undefined, collections?: readonly Collection<unknown>[] | undefined } = {}): KayPlugin {
  const feeds = options.feeds ?? []
  const extraCollections = options.collections ?? []

  function dirOf(c: InternalCollection, root?: string): string {
    return c[COLLECTION_DIR_FOR_ROOT_KEY]?.(root) ?? c.dir
  }

  function activeCollections(root?: string): InternalCollection[] {
    const out = new Set<InternalCollection>()
    for (const f of feeds)
      out.add(f.collection as InternalCollection)
    for (const c of extraCollections)
      out.add(c as InternalCollection)
    const absRoot = root !== undefined ? resolve(root) : getAppContext()?.root
    for (const c of registeredCollections) {
      const dir = dirOf(c, absRoot)
      if (!existsSync(dir))
        continue
      if (absRoot === undefined || isInsideOrSame(absRoot, dir))
        out.add(c)
    }
    return [...out]
  }

  return definePlugin({
    name: '@kayjs/content',
    after: ['@kayjs/i18n'],
    watchPaths: (root) => {
      const dirs = new Set<string>()
      for (const c of activeCollections(root))
        dirs.add(dirOf(c, root))
      return [...dirs]
    },
    async check(ctx) {
      await discoverAppCollections(ctx.root)
      const seen = new Set<string>()
      for (const c of activeCollections(ctx.root)) {
        const validate = c[COLLECTION_VALIDATE_KEY]
        if (validate === undefined)
          continue
        for (const err of validate(ctx.root)) {
          if (seen.has(err))
            continue
          seen.add(err)
          ctx.error(err)
        }
      }
    },
    build(ctx) {
      for (const feed of feeds) {
        const rel = (feed.path ?? '/rss.xml').replace(/^\/+/, '')
        ctx.emitPublic(rel, renderRss({ ...feed, site: feed.site ?? ctx.site } as RssFeedConfig<unknown>))
      }
    },
    server(api) {
      for (const feed of feeds) {
        const path = feed.path ?? '/rss.xml'
        let memo: { xml: string, etag: string, version: number } | undefined
        api.route('GET', path, (ctx) => {
          const versionFn = (feed.collection as unknown as Record<symbol, (() => number) | undefined>)[COLLECTION_VERSION_KEY]
          const version = versionFn ? versionFn() : -1
          if (api.dev || memo === undefined || memo.version !== version) {
            const xml = renderRss({ ...feed, site: feed.site ?? api.site } as RssFeedConfig<unknown>)
            const etag = `"${Bun.hash(xml).toString(36)}"`
            memo = { xml, etag, version }
          }
          if (etagMatches(ctx.request.headers.get('if-none-match'), memo.etag)) {
            return new Response(null, {
              status: 304,
              headers: { etag: memo.etag },
            })
          }
          return new Response(memo.xml, {
            headers: {
              'content-type': 'application/rss+xml; charset=utf-8',
              'etag': memo.etag,
            },
          })
        })
      }
    },
  })
}

/** Alias of `contentPlugin` matching the standard plugin factory naming (`seo()`, `i18n()`, `images()`, `content()`). */
export const content = contentPlugin
