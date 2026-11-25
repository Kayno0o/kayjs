// @kayjs/content — Zero-dependency Bun-native Markdown collections, nested YAML frontmatter (Bun.YAML),
// Shiki/custom highlight hook, MDX-lite embedded TSX components, localized collections, TOC, and RSS (`0 KB` client JS).

import type { KayPlugin, StandardSchemaV1 } from 'kay/server'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { getAppContext } from 'kay/server'
import { raw, ssrRaw } from 'kay/ssr'

const CONTENT_IMAGE_RESOLVER_SERVICE = 'kay.content.imageResolver'
const COLLECTION_VERSION_KEY = Symbol.for('kay.content.collectionVersion')

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

// Safe recursive-descent JSON5-literal parser for embedded Markdown component props.
// Supports objects (unquoted/quoted keys, trailing commas), arrays (trailing commas),
// single/double-quoted strings, numbers (sign, float, exponent, hex), booleans, null, undefined.
// Rejects all arbitrary JS expressions (calls, operators, identifiers, templates, etc.).
function parseLiteralValue(src: string): unknown {
  let i = 0
  const len = src.length

  function skipWsAndComments(): void {
    while (i < len) {
      const ch = src[i]!
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        i++
        continue
      }
      if (ch === '/' && src[i + 1] === '/') {
        i += 2
        while (i < len && src[i] !== '\n') i++
        continue
      }
      if (ch === '/' && src[i + 1] === '*') {
        i += 2
        const end = src.indexOf('*/', i)
        if (end === -1)
          throw new SyntaxError('Unterminated block comment')
        i = end + 2
        continue
      }
      break
    }
  }

  function parseString(quote: string): string {
    i++ // skip opening quote
    let out = ''
    while (i < len) {
      const ch = src[i]!
      if (ch === quote) {
        i++
        return out
      }
      if (ch === '\\') {
        i++
        if (i >= len)
          throw new SyntaxError('Unterminated string escape')
        const esc = src[i++]!
        switch (esc) {
          case 'n': out += '\n'; break
          case 'r': out += '\r'; break
          case 't': out += '\t'; break
          case 'b': out += '\b'; break
          case 'f': out += '\f'; break
          case 'v': out += '\v'; break
          case '0': out += '\0'; break
          case '\n': break
          case '\r': if (src[i] === '\n') i++; break
          case 'x': {
            const hex = src.slice(i, i + 2)
            if (!/^[0-9a-fA-F]{2}$/.test(hex))
              throw new SyntaxError('Invalid hex escape')
            out += String.fromCharCode(Number.parseInt(hex, 16))
            i += 2
            break
          }
          case 'u': {
            if (src[i] === '{') {
              const close = src.indexOf('}', i + 1)
              if (close === -1)
                throw new SyntaxError('Unterminated unicode escape')
              const hex = src.slice(i + 1, close)
              if (!/^[0-9a-fA-F]+$/.test(hex))
                throw new SyntaxError('Invalid unicode escape')
              out += String.fromCodePoint(Number.parseInt(hex, 16))
              i = close + 1
            }
            else {
              const hex = src.slice(i, i + 4)
              if (!/^[0-9a-fA-F]{4}$/.test(hex))
                throw new SyntaxError('Invalid unicode escape')
              out += String.fromCharCode(Number.parseInt(hex, 16))
              i += 4
            }
            break
          }
          default: out += esc; break
        }
        continue
      }
      if (ch === '\n' || ch === '\r')
        throw new SyntaxError('Unescaped newline in string')
      out += ch
      i++
    }
    throw new SyntaxError('Unterminated string literal')
  }

  function parseNumber(): number {
    const start = i
    if (src[i] === '+' || src[i] === '-')
      i++
    if (src[i] === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
      i += 2
      const hexStart = i
      while (i < len && /[0-9a-fA-F]/.test(src[i]!)) i++
      if (i === hexStart)
        throw new SyntaxError('Invalid hex number')
      const sign = src[start] === '-' ? -1 : 1
      return sign * Number.parseInt(src.slice(hexStart, i), 16)
    }
    let hasDigits = false
    while (i < len && /[0-9]/.test(src[i]!)) {
      hasDigits = true
      i++
    }
    if (src[i] === '.') {
      i++
      while (i < len && /[0-9]/.test(src[i]!)) {
        hasDigits = true
        i++
      }
    }
    if (!hasDigits)
      throw new SyntaxError('Invalid number')
    if (src[i] === 'e' || src[i] === 'E') {
      i++
      if (src[i] === '+' || src[i] === '-')
        i++
      const expStart = i
      while (i < len && /[0-9]/.test(src[i]!)) i++
      if (i === expStart)
        throw new SyntaxError('Invalid exponent')
    }
    const num = Number(src.slice(start, i))
    if (Number.isNaN(num))
      throw new SyntaxError('Invalid number')
    return num
  }

  function parseArray(): unknown[] {
    i++ // skip '['
    const arr: unknown[] = []
    while (true) {
      skipWsAndComments()
      if (i >= len)
        throw new SyntaxError('Unterminated array')
      if (src[i] === ']') {
        i++
        return arr
      }
      arr.push(parseValue())
      skipWsAndComments()
      if (src[i] === ',') {
        i++
        continue
      }
      if (src[i] === ']') {
        i++
        return arr
      }
      throw new SyntaxError('Expected "," or "]" in array')
    }
  }

  function parseObject(): Record<string, unknown> {
    i++ // skip '{'
    const obj: Record<string, unknown> = {}
    while (true) {
      skipWsAndComments()
      if (i >= len)
        throw new SyntaxError('Unterminated object')
      if (src[i] === '}') {
        i++
        return obj
      }
      let key: string
      const ch = src[i]!
      if (ch === '"' || ch === '\'') {
        key = parseString(ch)
      }
      else if (/[A-Za-z_$]/.test(ch)) {
        const keyStart = i
        while (i < len && /[A-Za-z0-9_$]/.test(src[i]!)) i++
        key = src.slice(keyStart, i)
      }
      else {
        throw new SyntaxError('Expected object key')
      }
      skipWsAndComments()
      if (src[i] !== ':')
        throw new SyntaxError('Expected ":" after object key')
      i++
      const val = parseValue()
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
        Object.defineProperty(obj, key, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      skipWsAndComments()
      if (src[i] === ',') {
        i++
        continue
      }
      if (src[i] === '}') {
        i++
        return obj
      }
      throw new SyntaxError('Expected "," or "}" in object')
    }
  }

  function parseValue(): unknown {
    skipWsAndComments()
    if (i >= len)
      throw new SyntaxError('Unexpected end of literal')
    const ch = src[i]!
    if (ch === '"' || ch === '\'')
      return parseString(ch)
    if (ch === '[')
      return parseArray()
    if (ch === '{')
      return parseObject()
    if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9'))
      return parseNumber()
    if (src.startsWith('true', i) && !/[A-Za-z0-9_$]/.test(src[i + 4] ?? '')) {
      i += 4
      return true
    }
    if (src.startsWith('false', i) && !/[A-Za-z0-9_$]/.test(src[i + 5] ?? '')) {
      i += 5
      return false
    }
    if (src.startsWith('null', i) && !/[A-Za-z0-9_$]/.test(src[i + 4] ?? '')) {
      i += 4
      return null
    }
    if (src.startsWith('undefined', i) && !/[A-Za-z0-9_$]/.test(src[i + 9] ?? '')) {
      i += 9
      return undefined
    }
    throw new SyntaxError(`Unsupported non-literal expression at offset ${i}`)
  }

  const value = parseValue()
  skipWsAndComments()
  if (i !== len)
    throw new SyntaxError(`Unexpected trailing token at offset ${i}`)
  return value
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
        props[name] = parseLiteralValue(expr)
      }
      catch {
        // Reject/ignore arbitrary non-literal JS expressions
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
  return getAppContext()?.inject<MarkdownImageResolver>(CONTENT_IMAGE_RESOLVER_SERVICE)
}

function resolveCollectionDir(dir: string): string {
  if (isAbsolute(dir))
    return dir
  const kayRoot = getAppContext()?.root
  if (typeof kayRoot === 'string' && kayRoot !== '') {
    const candidate = resolve(kayRoot, dir)
    if (existsSync(candidate))
      return candidate
  }
  return resolve(dir)
}

const DROP_CONTENT_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'applet',
  'noscript',
  'template',
])

const ALLOWED_MD_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr', 'div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main',
  'a', 'img', 'picture', 'source',
  'pre', 'code', 'kbd', 'samp', 'var',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'blockquote', 'q', 'cite', 'abbr', 'time', 'mark', 'small', 'ins', 'del', 's', 'u', 'b', 'i', 'strong', 'em', 'sup', 'sub', 'wbr',
  'details', 'summary', 'figure', 'figcaption',
  'input',
])

const URL_ATTRS = new Set(['href', 'src', 'cite', 'poster', 'action', 'formaction'])
const FORBIDDEN_ATTRS = new Set(['srcdoc', 'action', 'formaction', 'xmlns', 'xlink:href'])
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i
const SAFE_SCHEME_RE = /^(?:https?|mailto|tel):/i
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

function decodeHtmlEntities(rawVal: string): string {
  return rawVal
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => {
      const cp = Number.parseInt(hex, 16)
      return Number.isFinite(cp) && cp <= 0x10FFFF ? String.fromCodePoint(cp) : ''
    })
    .replace(/&#([0-9]+);?/g, (_, dec: string) => {
      const cp = Number.parseInt(dec, 10)
      return Number.isFinite(cp) && cp <= 0x10FFFF ? String.fromCodePoint(cp) : ''
    })
    .replaceAll('&colon;', ':')
    .replaceAll('&tab;', '\t')
    .replaceAll('&newline;', '\n')
    .replaceAll('&amp;', '&')
}

function isSafeUrl(val: string): boolean {
  const cleaned = decodeHtmlEntities(val).replace(/[\u0000-\u0020\u007F]+/g, '').trim()
  if (cleaned === '')
    return true
  if (SAFE_SCHEME_RE.test(cleaned) || SAFE_DATA_IMAGE_RE.test(cleaned))
    return true
  if (HAS_SCHEME_RE.test(cleaned))
    return false
  return true
}

function parseTagAttributes(attrSrc: string): Array<{ name: string, value: string | null }> {
  const attrs: Array<{ name: string, value: string | null }> = []
  let i = 0
  const len = attrSrc.length
  while (i < len) {
    while (i < len && /[\s/]/.test(attrSrc[i]!)) i++
    if (i >= len) break
    const nameStart = i
    while (i < len && !/[\s=/>"'<]/.test(attrSrc[i]!)) i++
    const name = attrSrc.slice(nameStart, i).toLowerCase()
    if (!name) {
      i++
      continue
    }
    while (i < len && /\s/.test(attrSrc[i]!)) i++
    if (attrSrc[i] !== '=') {
      attrs.push({ name, value: null })
      continue
    }
    i++ // skip '='
    while (i < len && /\s/.test(attrSrc[i]!)) i++
    if (i >= len) {
      attrs.push({ name, value: '' })
      break
    }
    const quote = attrSrc[i]!
    if (quote === '"' || quote === '\'') {
      i++
      const valStart = i
      while (i < len && attrSrc[i] !== quote) i++
      attrs.push({ name, value: attrSrc.slice(valStart, i) })
      if (i < len) i++
    }
    else {
      const valStart = i
      while (i < len && !/[\s>]/.test(attrSrc[i]!)) i++
      attrs.push({ name, value: attrSrc.slice(valStart, i) })
    }
  }
  return attrs
}

function sanitizePass(html: string): string {
  let out = ''
  let i = 0
  const len = html.length

  while (i < len) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      out += html.slice(i)
      break
    }
    out += html.slice(i, lt)

    // Strip HTML comments
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end === -1 ? len : end + 3
      continue
    }

    // Parse tag start
    let pos = lt + 1
    const isClosing = html[pos] === '/'
    if (isClosing)
      pos++

    const nameStart = pos
    while (pos < len && /[A-Za-z0-9:-]/.test(html[pos]!)) pos++
    const tagName = html.slice(nameStart, pos).toLowerCase()
    if (!tagName) {
      out += '&lt;'
      i = lt + 1
      continue
    }

    // Find tag end respecting quoted attribute values
    let tagEnd = pos
    let inQuote: string | null = null
    while (tagEnd < len) {
      const c = html[tagEnd]!
      if (inQuote !== null) {
        if (c === inQuote)
          inQuote = null
      }
      else {
        if (c === '"' || c === '\'')
          inQuote = c
        else if (c === '>')
          break
      }
      tagEnd++
    }
    if (tagEnd >= len) {
      // Unclosed tag at EOF: drop it
      break
    }

    const attrSrc = html.slice(pos, tagEnd)
    const selfClosing = !isClosing && /\/\s*$/.test(attrSrc)
    i = tagEnd + 1

    // Drop dangerous container tags together with their inner content
    if (!isClosing && DROP_CONTENT_TAGS.has(tagName)) {
      if (!selfClosing) {
        const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi')
        closeRe.lastIndex = i
        const m = closeRe.exec(html)
        i = m ? m.index + m[0].length : len
      }
      continue
    }

    // Strip any non-allowlisted tag (e.g. <embed>, <form>, <base>, <meta>, <link>, <svg>, etc.)
    if (!ALLOWED_MD_TAGS.has(tagName))
      continue

    if (isClosing) {
      if (tagName !== 'input' && tagName !== 'br' && tagName !== 'hr' && tagName !== 'img')
        out += `</${tagName}>`
      continue
    }

    const rawAttrs = parseTagAttributes(attrSrc)

    // Allow <input> strictly for GFM tasklist checkboxes
    if (tagName === 'input') {
      const typeAttr = rawAttrs.find(a => a.name === 'type')
      if (typeAttr?.value?.toLowerCase() !== 'checkbox')
        continue
      const safeParts = ['type="checkbox"']
      for (const a of rawAttrs) {
        if (a.name === 'class' && a.value !== null)
          safeParts.push(`class="${a.value.replaceAll('"', '&quot;')}"`)
        else if (a.name === 'disabled')
          safeParts.push('disabled')
        else if (a.name === 'checked')
          safeParts.push('checked')
      }
      out += `<input ${safeParts.join(' ')}>`
      continue
    }

    const safeParts: string[] = []
    for (const a of rawAttrs) {
      if (a.name.startsWith('on') || FORBIDDEN_ATTRS.has(a.name))
        continue
      if (URL_ATTRS.has(a.name)) {
        if (a.value === null || !isSafeUrl(a.value))
          continue
      }
      else if (a.name === 'srcset' && a.value !== null) {
        const candidates = a.value.split(',').map(s => s.trim().split(/\s+/)[0] ?? '')
        if (!candidates.every(isSafeUrl))
          continue
      }
      if (a.value === null)
        safeParts.push(a.name)
      else
        safeParts.push(`${a.name}="${a.value.replaceAll('"', '&quot;')}"`)
    }

    const attrOut = safeParts.length > 0 ? ` ${safeParts.join(' ')}` : ''
    out += selfClosing ? `<${tagName}${attrOut} />` : `<${tagName}${attrOut}>`
  }

  return out
}

function sanitizeMarkdownHtml(html: string): string {
  let current = html
  for (let pass = 0; pass < 3; pass++) {
    const next = sanitizePass(current)
    if (next === current)
      return next
    current = next
  }
  return current
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

  // 3b. Sanitize rendered Markdown HTML by default unless `trusted: true` is opted into.
  // Runs before splicing developer-supplied highlight/component slots so custom components remain intact.
  if (options.trusted !== true)
    html = sanitizeMarkdownHtml(html)

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

function isInside(dir: string, target: string): boolean {
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
  const allCache = new Map<string, ContentEntry<TData>[]>()
  const slugCache = new Map<string, Map<string, ContentEntry<TData>>>()
  let cacheVersion = 0

  function isDevMode(): boolean {
    return process.env.KAY_DEV === '1'
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

  // Slugs and locales usually come from URL params: a path built from them must stay inside the collection folder.
  function localeDir(absDir: string, targetLocale: string | undefined): string | undefined {
    if (targetLocale === undefined)
      return absDir
    const scanDir = resolve(absDir, targetLocale)
    return isInside(absDir, scanDir) && scanDir !== absDir ? scanDir : undefined
  }

  function all(locale?: string): ContentEntry<TData>[] {
    const absDir = getDir()
    const targetLocale = localized ? (locale ?? defaultLocale) : undefined
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

  const col: Collection<TData> & { [COLLECTION_VERSION_KEY]: () => number } = {
    get dir() {
      return getDir()
    },
    all,
    get(slug, locale) {
      const absDir = getDir()
      const clean = slug.replace(/^\/+|\/+$/g, '')
      const targetLocale = localized ? (locale ?? defaultLocale) : undefined
      const scanDir = localeDir(absDir, targetLocale)
      if (scanDir === undefined || !isInside(scanDir, resolve(scanDir, clean)))
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
  }
  return col
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

function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch)
    return false
  const trimmed = ifNoneMatch.trim()
  if (trimmed === '*')
    return true
  const target = etag.replace(/^W\//, '')
  return trimmed.split(',').some(part => part.trim().replace(/^W\//, '') === target)
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
        let memo: { xml: string, etag: string, version: number } | undefined
        api.route('GET', path, (ctx) => {
          const versionFn = (feed.collection as unknown as Record<symbol, (() => number) | undefined>)[COLLECTION_VERSION_KEY]
          const version = versionFn ? versionFn() : -1
          if (api.dev || memo === undefined || memo.version !== version) {
            const xml = renderRss(feed)
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
  }
}
