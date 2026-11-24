// @kayjs/content — Zero-dependency Bun-native Markdown collections, nested YAML frontmatter (Bun.YAML),
// Shiki/custom highlight hook, MDX-lite embedded TSX components, localized collections, TOC, and RSS (`0 KB` client JS).

import type { KayPlugin, StandardSchemaV1 } from 'kay/server'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { raw, ssrRaw } from 'kay/ssr'

const KAY_ROOT_KEY = Symbol.for('kay.root')
const IMAGE_RESOLVERS_KEY = Symbol.for('kay.content.imageResolvers')

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

export type MarkdownComponent = (props: any) => unknown
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
  return html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', '\'')
    .replaceAll('&amp;', '&')
    .trim()
}

// Parse JSX-style attributes inside embedded Markdown components: title="hi" count={42} rows={[...]} flag
function parseComponentProps(attrSrc: string): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  let i = 0
  const len = attrSrc.length

  while (i < len) {
    while (i < len && /\s/.test(attrSrc[i]!)) i++
    if (i >= len) break

    const nameStart = i
    while (i < len && /[\w:-]/.test(attrSrc[i]!)) i++
    const name = attrSrc.slice(nameStart, i)
    if (!name) {
      i++
      continue
    }

    while (i < len && /\s/.test(attrSrc[i]!)) i++
    if (attrSrc[i] !== '=') {
      props[name] = true
      continue
    }
    i++ // skip '='
    while (i < len && /\s/.test(attrSrc[i]!)) i++

    const ch = attrSrc[i]
    if (ch === '"' || ch === '\'') {
      const quote = ch
      i++
      const valStart = i
      while (i < len && attrSrc[i] !== quote) {
        if (attrSrc[i] === '\\') i++
        i++
      }
      props[name] = attrSrc.slice(valStart, i)
      i++
    }
    else if (ch === '{') {
      let depth = 0
      const exprStart = i + 1
      let inStr: string | null = null
      while (i < len) {
        const c = attrSrc[i]!
        if (inStr !== null) {
          if (c === '\\') { i += 2; continue }
          if (c === inStr) inStr = null
        }
        else {
          if (c === '"' || c === '\'' || c === '`') inStr = c
          else if (c === '{') depth++
          else if (c === '}') {
            depth--
            if (depth === 0) break
          }
        }
        i++
      }
      const expr = attrSrc.slice(exprStart, i).trim()
      i++ // skip closing '}'
      try {
        props[name] = JSON.parse(expr)
      }
      catch {
        // eslint-disable-next-line no-new-func
        props[name] = new Function(`return (${expr})`)()
      }
    }
  }
  return props
}

// Find the end of an opening JSX tag (`>` or `/>`), respecting strings and balanced `{...}` expressions.
function findTagEnd(src: string, start: number): { end: number, selfClosing: boolean } | undefined {
  let i = start
  const len = src.length
  let braceDepth = 0
  let inStr: string | null = null

  while (i < len) {
    const c = src[i]!
    if (inStr !== null) {
      if (c === '\\') { i += 2; continue }
      if (c === inStr) inStr = null
      i++
      continue
    }
    if (c === '"' || c === '\'' || c === '`') {
      inStr = c
      i++
      continue
    }
    if (c === '{') {
      braceDepth++
      i++
      continue
    }
    if (c === '}') {
      braceDepth = Math.max(0, braceDepth - 1)
      i++
      continue
    }
    if (braceDepth === 0) {
      if (c === '/' && src[i + 1] === '>')
        return { end: i + 2, selfClosing: true }
      if (c === '>')
        return { end: i + 1, selfClosing: false }
    }
    i++
  }
  return undefined
}

function expandComponents(
  md: string,
  components: Record<string, MarkdownComponent>,
  options: RenderMarkdownOptions,
  slots: string[],
  slotPrefix: string,
): string {
  const names = Object.keys(components)
  if (names.length === 0)
    return md

  let out = ''
  let i = 0
  const len = md.length

  while (i < len) {
    const lt = md.indexOf('<', i)
    if (lt === -1) {
      out += md.slice(i)
      break
    }

    const match = /^<([A-Z][\w]*)(?=[\s/>])/.exec(md.slice(lt))
    if (!match || !(match[1]! in components)) {
      out += md.slice(i, lt + 1)
      i = lt + 1
      continue
    }

    const tagName = match[1]!
    const tagEnd = findTagEnd(md, lt + match[0].length)
    if (!tagEnd) {
      out += md.slice(i, lt + 1)
      i = lt + 1
      continue
    }

    out += md.slice(i, lt)
    const attrSrc = md.slice(lt + match[0].length, tagEnd.selfClosing ? tagEnd.end - 2 : tagEnd.end - 1)
    const props = parseComponentProps(attrSrc)
    let afterIndex = tagEnd.end

    if (!tagEnd.selfClosing) {
      // Find matching closing </TagName> with nesting depth
      const closeTag = `</${tagName}>`
      const openRe = new RegExp(`<${tagName}(?=[\\s/>])|</${tagName}>`, 'g')
      openRe.lastIndex = tagEnd.end
      let depth = 1
      let closeIdx = -1
      let m: RegExpExecArray | null
      while ((m = openRe.exec(md)) !== null) {
        if (m[0] === closeTag) {
          depth--
          if (depth === 0) {
            closeIdx = m.index
            break
          }
        }
        else {
          const innerEnd = findTagEnd(md, m.index + m[0].length)
          if (innerEnd && !innerEnd.selfClosing)
            depth++
        }
      }
      if (closeIdx !== -1) {
        const innerMd = md.slice(tagEnd.end, closeIdx).trim()
        const innerRendered = renderMarkdown(innerMd, options)
        props.children = raw(innerRendered.html.trim())
        afterIndex = closeIdx + closeTag.length
      }
    }

    if (options.locale !== undefined && props.locale === undefined)
      props.locale = options.locale

    const renderedHtml = ssrRaw(components[tagName]!(props))
    const slotIdx = slots.length
    slots.push(renderedHtml)
    out += `\n\n<div data-kay-md-slot="${slotPrefix}${slotIdx}"></div>\n\n`
    i = afterIndex
  }

  return out
}

function findDefaultImageResolver(file: string | undefined): MarkdownImageResolver | undefined {
  if (!file)
    return undefined
  const registry = (globalThis as Record<symbol, unknown>)[IMAGE_RESOLVERS_KEY] as Map<string, MarkdownImageResolver> | undefined
  if (!registry || registry.size === 0)
    return undefined
  const absFile = resolve(file)
  let bestRoot = ''
  let bestResolver: MarkdownImageResolver | undefined
  for (const [root, resolver] of registry) {
    if ((absFile === root || absFile.startsWith(`${root}/`) || absFile.startsWith(`${root}\\`)) && root.length > bestRoot.length) {
      bestRoot = root
      bestResolver = resolver
    }
  }
  return bestResolver
}

function resolveCollectionDir(dir: string): string {
  if (isAbsolute(dir))
    return dir
  const kayRoot = (globalThis as Record<symbol, unknown>)[KAY_ROOT_KEY]
  if (typeof kayRoot === 'string' && kayRoot !== '') {
    const candidate = resolve(kayRoot, dir)
    if (existsSync(candidate))
      return candidate
  }
  return resolve(dir)
}

const FENCE_RE = /^([`~]{3,})([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm
let slotBatchId = 0

/** Renders Markdown via Bun's native Zig `Bun.markdown.html()`, with optional Shiki `highlight`, embedded TSX `components`, heading IDs, TOC, and reading time. */
export function renderMarkdown(body: string, options: RenderMarkdownOptions = {}): {
  html: string
  headings: ContentHeading[]
  wordCount: number
  readingMinutes: number
} {
  const slots: string[] = []
  const slotPrefix = `b${++slotBatchId}-`
  let processed = body

  // 1. Extract fenced code blocks before component expansion so `<Tag>` inside ```code``` is never treated as a component
  if (options.highlight !== undefined || options.components !== undefined) {
    processed = processed.replace(FENCE_RE, (full, _fence: string, info: string, code: string) => {
      if (options.highlight !== undefined) {
        const lang = info.trim().split(/\s+/)[0] || undefined
        const idx = slots.length
        slots.push(options.highlight(code.replace(/\n$/, ''), lang))
        return `\n\n<div data-kay-md-slot="${slotPrefix}${idx}"></div>\n\n`
      }
      // Protect code fences from component expansion when only components are configured
      const idx = slots.length
      slots.push(Bun.markdown.html(full, { tables: true, strikethrough: true, tasklists: true, autolinks: true }))
      return `\n\n<div data-kay-md-slot="${slotPrefix}${idx}"></div>\n\n`
    })
  }

  // 2. Expand embedded TSX components
  if (options.components !== undefined)
    processed = expandComponents(processed, options.components, options, slots, slotPrefix)

  // 3. Render remaining Markdown via native Zig Bun.markdown.html
  let html = Bun.markdown.html(processed, {
    tables: true,
    strikethrough: true,
    tasklists: true,
    autolinks: true,
  })

  // 4. Add unique heading IDs & collect TOC
  const headings: ContentHeading[] = []
  const usedIds = new Map<string, number>()

  html = html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_match, levelStr: string, inner: string) => {
    const level = Number(levelStr)
    const text = stripTags(inner)
    const base = slugifyHeading(text)
    const count = usedIds.get(base) ?? 0
    usedIds.set(base, count + 1)
    const id = count === 0 ? base : `${base}-${count}`
    headings.push({ level, id, text })
    if (options.headingLinks && level >= 2)
      return `<h${level} id="${id}"><a href="#${id}">${inner}</a></h${level}>`
    return `<h${level} id="${id}">${inner}</h${level}>`
  })

  // 4b. Image rewriting (explicit resolveImage or auto-wired @kayjs/images; `false` disables)
  const resolveImageFn = options.resolveImage === false
    ? undefined
    : (options.resolveImage ?? findDefaultImageResolver(options.file))
  if (resolveImageFn !== undefined) {
    html = html.replace(/<img\b([^>]*?)>/gi, (full, attrs: string) => {
      const srcMatch = /\bsrc="([^"]+)"/i.exec(attrs)
      if (!srcMatch)
        return full
      const resolved = resolveImageFn(srcMatch[1]!, options.file)
      if (!resolved)
        return full
      const info: MarkdownImageResult = typeof resolved === 'string' ? { src: resolved } : resolved
      const altMatch = /\balt="([^"]*)"/i.exec(attrs)
      const alt = altMatch ? altMatch[1]! : ''
      const parts = [`src="${escapeXml(info.src)}"`, `alt="${alt}"`]
      if (info.srcset)
        parts.push(`srcset="${escapeXml(info.srcset)}"`)
      if (info.sizes)
        parts.push(`sizes="${escapeXml(info.sizes)}"`)
      if (info.width !== undefined && info.width > 0)
        parts.push(`width="${info.width}"`)
      if (info.height !== undefined && info.height > 0)
        parts.push(`height="${info.height}"`)
      parts.push(`loading="${info.loading ?? 'lazy'}"`, 'decoding="async"')
      const imgTag = `<img ${parts.join(' ')}>`
      if (info.avifSrcset) {
        const sizesAttr = info.sizes ? ` sizes="${escapeXml(info.sizes)}"` : ''
        return `<picture><source type="image/avif" srcset="${escapeXml(info.avifSrcset)}"${sizesAttr}>${imgTag}</picture>`
      }
      return imgTag
    })
  }

  // 5. Splice this batch's highlighted code blocks & embedded TSX components back in (loop handles components wrapping code fences)
  if (slots.length > 0) {
    const slotRe = new RegExp(`<div data-kay-md-slot="${slotPrefix}(\\d+)"><\\/div>`, 'g')
    let prev = ''
    while (prev !== html) {
      prev = html
      html = html.replace(slotRe, (_m, idxStr: string) => slots[Number(idxStr)] ?? '')
    }
  }

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
  const at = ad instanceof Date ? ad.getTime() : (typeof ad === 'string' || typeof ad === 'number' ? Date.parse(String(ad)) : Number.NaN)
  const bt = bd instanceof Date ? bd.getTime() : (typeof bd === 'string' || typeof bd === 'number' ? Date.parse(String(bd)) : Number.NaN)
  if (!Number.isNaN(at) && !Number.isNaN(bt) && at !== bt)
    return bt - at
  return a.slug.localeCompare(b.slug)
}

export function defineCollection<TData = Record<string, unknown>>(options: CollectionOptions<TData>): Collection<TData> {
  const getDir = () => resolveCollectionDir(options.dir)
  const includeDrafts = options.includeDrafts ?? false
  const localized = options.localized ?? false
  const defaultLocale = options.defaultLocale ?? 'en'
  const baseRenderOpts: RenderMarkdownOptions = {
    highlight: options.highlight,
    components: options.components,
    headingLinks: options.headingLinks,
    resolveImage: options.resolveImage,
  }
  let resolvedRenderOpts: RenderMarkdownOptions | undefined = options.render === undefined ? baseRenderOpts : undefined
  let pendingRenderOpts: Promise<RenderMarkdownOptions> | undefined

  function mergeRenderConfig(cfg: CollectionRenderConfig): RenderMarkdownOptions {
    return {
      highlight: cfg.highlight ?? baseRenderOpts.highlight,
      components: cfg.components ?? baseRenderOpts.components,
      headingLinks: cfg.headingLinks ?? baseRenderOpts.headingLinks,
      resolveImage: cfg.resolveImage !== undefined ? cfg.resolveImage : baseRenderOpts.resolveImage,
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
    })
    return pendingRenderOpts
  }

  const cache = new Map<string, { mtimeMs: number, entry: ContentEntry<TData> | null }>()

  function loadFile(absFile: string, baseDir: string, entryLocale?: string): ContentEntry<TData> | null {
    const mtimeMs = statSync(absFile).mtimeMs
    const cached = cache.get(absFile)
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

  function all(locale?: string): ContentEntry<TData>[] {
    const absDir = getDir()
    const targetLocale = localized ? (locale ?? defaultLocale) : undefined
    const scanDir = targetLocale !== undefined ? join(absDir, targetLocale) : absDir
    const files = walkMarkdownFiles(scanDir)
    const entries: ContentEntry<TData>[] = []
    for (const f of files) {
      const entry = loadFile(f, scanDir, targetLocale)
      if (entry === null)
        continue
      entries.push(entry)
    }
    entries.sort(options.sort ?? defaultSort)
    return entries
  }

  return {
    get dir() {
      return getDir()
    },
    all,
    get(slug, locale) {
      const absDir = getDir()
      const clean = slug.replace(/^\/+|\/+$/g, '')
      const targetLocale = localized ? (locale ?? defaultLocale) : undefined
      const scanDir = targetLocale !== undefined ? join(absDir, targetLocale) : absDir
      // O(1) direct file lookup before falling back to directory scan
      for (const candidate of [
        join(scanDir, `${clean}.md`),
        join(scanDir, `${clean}.markdown`),
        join(scanDir, clean, 'index.md'),
        join(scanDir, clean, 'index.markdown'),
      ]) {
        if (existsSync(candidate))
          return loadFile(candidate, scanDir, targetLocale) ?? undefined
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

export function contentPlugin(options: { feeds?: RssFeedConfig<any>[] | undefined, collections?: Collection<any>[] | undefined } = {}): KayPlugin {
  const feeds = options.feeds ?? []
  const extraCollections = options.collections ?? []
  return {
    name: '@kayjs/content',
    watchPaths: () => {
      const dirs = new Set<string>()
      for (const f of feeds)
        dirs.add(f.collection.dir)
      for (const c of extraCollections)
        dirs.add(c.dir)
      return [...dirs]
    },
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
