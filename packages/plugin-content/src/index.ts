// @kayjs/content — Zero-dependency Bun-native Markdown collections, frontmatter, Standard Schema validation,
// heading TOC extraction, reading time, prerender paths(), and RSS feed plugin (`0 KB` client JS).

import type { KayPlugin, StandardSchemaV1 } from 'kay/server'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export interface ContentHeading {
  level: number
  id: string
  text: string
}

export interface ContentEntry<TData = Record<string, unknown>> {
  readonly slug: string
  readonly file: string
  readonly data: TData
  readonly body: string
  readonly html: string
  readonly headings: readonly ContentHeading[]
  readonly wordCount: number
  readonly readingMinutes: number
}

export interface CollectionOptions<TData = Record<string, unknown>> {
  /** Directory containing `.md` / `.markdown` files (relative to cwd or absolute). */
  dir: string
  /** Optional Standard Schema (Zod, Valibot, ArkType, custom) to validate frontmatter. */
  schema?: StandardSchemaV1<unknown, TData> | undefined
  /** Include entries with `draft: true` (default: false in production, true in dev when unset). */
  includeDrafts?: boolean | undefined
  /** Custom comparator for `all()` (defaults to newest `date` first, then alphabetical `slug`). */
  sort?: ((a: ContentEntry<TData>, b: ContentEntry<TData>) => number) | undefined
}

export interface Collection<TData = Record<string, unknown>> {
  all(): ContentEntry<TData>[]
  get(slug: string): ContentEntry<TData> | undefined
  byTag(tag: string): ContentEntry<TData>[]
  /** Returns URL paths for `export const prerender = true; export const paths = () => col.paths('/blog')`. */
  paths(prefix?: string): string[]
  clearCache(): void
}

function unquote(raw: string): string {
  const s = raw.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\'')))
    return s.slice(1, -1)
  return s
}

function parseScalar(raw: string): unknown {
  const s = raw.trim()
  if (s === '' || s === 'null' || s === '~')
    return null
  if (s === 'true')
    return true
  if (s === 'false')
    return false
  if (/^-?\d+(?:\.\d+)?$/.test(s))
    return Number(s)
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner)
      return []
    return inner.split(',').map(part => parseScalar(part))
  }
  return unquote(s)
}

/** Lightweight zero-dependency YAML frontmatter parser (scalars, inline arrays, block lists). */
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

  const data: Record<string, unknown> = {}
  const lines = rawYaml.split('\n')
  let activeListKey: string | undefined

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#'))
      continue

    if (activeListKey !== undefined && /^\s*-\s+/.test(line)) {
      const val = parseScalar(line.replace(/^\s*-\s+/, ''))
      ;(data[activeListKey] as unknown[]).push(val)
      continue
    }

    activeListKey = undefined
    const colon = line.indexOf(':')
    if (colon <= 0)
      continue
    const key = line.slice(0, colon).trim()
    const valuePart = line.slice(colon + 1).trim()

    if (valuePart === '') {
      data[key] = []
      activeListKey = key
    }
    else {
      data[key] = parseScalar(valuePart)
    }
  }

  return { data, body }
}

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section'
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim()
}

/** Renders Markdown via Bun's native Zig `Bun.markdown.html()`, adds unique heading IDs, and extracts TOC & reading time. */
export function renderMarkdown(body: string): {
  html: string
  headings: ContentHeading[]
  wordCount: number
  readingMinutes: number
} {
  const rawHtml = Bun.markdown.html(body, {
    tables: true,
    strikethrough: true,
    tasklists: true,
    autolinks: true,
  })

  const headings: ContentHeading[] = []
  const usedIds = new Map<string, number>()

  const html = rawHtml.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_match, levelStr: string, inner: string) => {
    const level = Number(levelStr)
    const text = stripTags(inner)
    const base = slugifyHeading(text)
    const count = usedIds.get(base) ?? 0
    usedIds.set(base, count + 1)
    const id = count === 0 ? base : `${base}-${count}`
    headings.push({ level, id, text })
    return `<h${level} id="${id}">${inner}</h${level}>`
  })

  const words = body.trim().split(/\s+/).filter(Boolean).length
  const readingMinutes = Math.max(1, Math.ceil(words / 220))
  return { html, headings, wordCount: words, readingMinutes }
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
  const at = typeof ad === 'string' || typeof ad === 'number' ? Date.parse(String(ad)) : Number.NaN
  const bt = typeof bd === 'string' || typeof bd === 'number' ? Date.parse(String(bd)) : Number.NaN
  if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt)
    return bt - at
  return a.slug.localeCompare(b.slug)
}

export function defineCollection<TData = Record<string, unknown>>(options: CollectionOptions<TData>): Collection<TData> {
  const absDir = resolve(options.dir)
  const includeDrafts = options.includeDrafts ?? false
  const cache = new Map<string, { mtimeMs: number, entry: ContentEntry<TData> }>()

  function loadFile(absFile: string): ContentEntry<TData> {
    const mtimeMs = statSync(absFile).mtimeMs
    const cached = cache.get(absFile)
    if (cached !== undefined && cached.mtimeMs === mtimeMs)
      return cached.entry

    const raw = readFileSync(absFile, 'utf8')
    const { data: rawData, body } = parseFrontmatter(raw)
    const slug = relative(absDir, absFile)
      .replace(/\\/g, '/')
      .replace(/\.(?:md|markdown)$/, '')
      .replace(/\/index$/, '')

    let data: TData
    if (options.schema !== undefined) {
      const checked = options.schema['~standard'].validate(rawData)
      if (checked instanceof Promise)
        throw new TypeError(`@kayjs/content: async frontmatter schema is not supported (${slug})`)
      if (checked.issues && checked.issues.length > 0) {
        const msg = checked.issues.map(i => i.message).join('; ')
        throw new Error(`@kayjs/content: invalid frontmatter in "${absFile}": ${msg}`)
      }
      data = (checked as { value: TData }).value
    }
    else {
      data = rawData as TData
    }

    const rendered = renderMarkdown(body)
    const entry: ContentEntry<TData> = {
      slug,
      file: absFile,
      data,
      body,
      html: rendered.html,
      headings: rendered.headings,
      wordCount: rendered.wordCount,
      readingMinutes: rendered.readingMinutes,
    }
    cache.set(absFile, { mtimeMs, entry })
    return entry
  }

  function all(): ContentEntry<TData>[] {
    const files = walkMarkdownFiles(absDir)
    const entries: ContentEntry<TData>[] = []
    for (const f of files) {
      const entry = loadFile(f)
      if (!includeDrafts && (entry.data as Record<string, unknown>).draft === true)
        continue
      entries.push(entry)
    }
    entries.sort(options.sort ?? defaultSort)
    return entries
  }

  return {
    all,
    get(slug) {
      const clean = slug.replace(/^\/+|\/+$/g, '')
      return all().find(e => e.slug === clean)
    },
    byTag(tag) {
      const needle = tag.toLowerCase()
      return all().filter((e) => {
        const tags = (e.data as Record<string, unknown>).tags
        return Array.isArray(tags) && tags.some(t => String(t).toLowerCase() === needle)
      })
    },
    paths(prefix = '') {
      const base = prefix.replace(/\/$/, '')
      return all().map(e => `${base}/${e.slug}`)
    },
    clearCache() {
      cache.clear()
    },
  }
}

export interface RssFeedConfig<TData = Record<string, unknown>> {
  /** Public path for the RSS XML file (default: '/rss.xml'). */
  path?: string | undefined
  title: string
  description: string
  site: string
  collection: Collection<TData>
  /** URL prefix prepended to each entry's slug (e.g. '/blog'). */
  linkPrefix?: string | undefined
  mapItem?: ((entry: ContentEntry<TData>) => {
    title: string
    description?: string | undefined
    date?: string | Date | undefined
    link?: string | undefined
  }) | undefined
}

function escapeXml(str: string): string {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')
}

export function renderRss<TData>(feed: RssFeedConfig<TData>): string {
  const site = feed.site.replace(/\/$/, '')
  const prefix = (feed.linkPrefix ?? '').replace(/\/$/, '')
  const items = feed.collection.all().map((entry) => {
    const raw = entry.data as Record<string, unknown>
    const mapped = feed.mapItem
      ? feed.mapItem(entry)
      : {
          title: String(raw.title ?? entry.slug),
          description: typeof raw.description === 'string' ? raw.description : undefined,
          date: raw.date as string | Date | undefined,
          link: `${site}${prefix}/${entry.slug}`,
        }
    const link = mapped.link ?? `${site}${prefix}/${entry.slug}`
    const pubDate = mapped.date ? `<pubDate>${new Date(mapped.date).toUTCString()}</pubDate>` : ''
    const desc = mapped.description ? `<description>${escapeXml(mapped.description)}</description>` : ''
    return `<item><title>${escapeXml(mapped.title)}</title><link>${escapeXml(link)}</link><guid>${escapeXml(link)}</guid>${pubDate}${desc}</item>`
  }).join('')

  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<rss version="2.0"><channel>`
    + `<title>${escapeXml(feed.title)}</title>`
    + `<link>${escapeXml(site)}</link>`
    + `<description>${escapeXml(feed.description)}</description>`
    + items
    + `</channel></rss>`
}

export function contentPlugin(options: { feeds?: RssFeedConfig<any>[] | undefined } = {}): KayPlugin {
  const feeds = options.feeds ?? []
  return {
    name: '@kayjs/content',
    build(ctx) {
      for (const feed of feeds) {
        const rel = (feed.path ?? '/rss.xml').replace(/^\/+/, '')
        ctx.emitPublic(rel, renderRss(feed))
      }
    },
    server(api) {
      for (const feed of feeds) {
        const path = feed.path ?? '/rss.xml'
        api.route('GET', path, () => new Response(renderRss(feed), {
          headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
        }))
      }
    },
  }
}
