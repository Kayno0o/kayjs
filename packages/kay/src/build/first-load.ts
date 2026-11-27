// What a first visit downloads, as served: the page, the files it links, and the files those pull in (a script's static imports, a stylesheet's `url()`s), each counted once. The docs footer and `kay build --analyze` both measure with this.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, posix } from 'node:path'
import { appBrotliCacheDir, brotliSync } from './precompress'

// A static `import ... from "./x.js"` or `import "./x.js"` of an emitted chunk; `import("./x.js")` stays lazy and is left out.
export const STATIC_CHUNK_IMPORT_RE = /\b(?:import|export)\s*(?:[^"'();]*?\bfrom\s*)?["'](\.\.?\/[^"']+\.js)["']/g

const TAG_RE = /<(img|script|link)\b[^>]*>/g
const SRC_RE = /\bsrc="([^"]+)"/
const HREF_RE = /\bhref="([^"]+)"/
const REL_RE = /\brel="([^"]+)"/
const TYPE_RE = /\btype="([^"]+)"/
const LAZY_RE = /\bloading="lazy"/
const FONT_FACE_RE = /@font-face\s*\{[^}]*\}/g
const CSS_URL_RE = /url\(\s*(["']?)([^)"']+)\1\s*\)/g
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?["']([^"']+)["']/g
const FETCHED_RELS = new Set(['stylesheet', 'modulepreload', 'preload'])
const COMPRESSED_EXTS = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.xml', '.json', '.txt', '.webmanifest'])
const FONT_EXTS = new Set(['.woff2', '.woff', '.ttf', '.otf'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico'])
const SKIPPED_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i

export interface FirstLoad {
  /** The page's own HTML, brotli, as given by the caller. */
  html: number
  css: number
  js: number
  fonts: number
  images: number
  other: number
  total: number
  /** The part of `total` a browser keeps in its cache for the next page: the files `cacheable` accepts. */
  cached: number
  /** Files counted besides the page. */
  files: number
}

/** Turns a URL the page links into the file that serves it, or `undefined` when no file does. */
export type Locate = (url: string) => string | undefined

/** The URLs a browser fetches from this markup: stylesheets, preloads, scripts, one icon, and images that are not lazy. */
export function firstLoadUrls(html: string): string[] {
  const urls = new Set<string>()
  const icons: string[] = []
  let svgIcon: string | undefined
  for (const [element, name] of html.matchAll(TAG_RE)) {
    if (name === 'link') {
      const url = HREF_RE.exec(element)?.[1]
      const relation = REL_RE.exec(element)?.[1] ?? ''
      if (url === undefined)
        continue
      if (relation === 'icon') {
        icons.push(url)
        svgIcon ??= TYPE_RE.exec(element)?.[1] === 'image/svg+xml' ? url : undefined
      }
      else if (FETCHED_RELS.has(relation)) {
        urls.add(url)
      }
      continue
    }
    const url = SRC_RE.exec(element)?.[1]
    if (url !== undefined && !LAZY_RE.test(element))
      urls.add(url)
  }
  // A browser that draws SVG icons fetches that one alone; the others are for browsers that do not.
  for (const icon of svgIcon === undefined ? icons : [svgIcon])
    urls.add(icon)
  return [...urls]
}

/** The locator for a build's output: `/_kay/x` is `clientDir/x`, anything else is looked up in each public dir. */
export function distLocator(options: { clientDir: string, assetPrefix: string, publicDirs: readonly string[] }): Locate {
  const prefix = `${options.assetPrefix.replace(/\/$/, '')}/`
  return (url) => {
    const path = url.split(/[?#]/)[0]!
    if (path.startsWith(prefix)) {
      const file = join(options.clientDir, path.slice(prefix.length))
      return existsSync(file) ? file : undefined
    }
    if (!path.startsWith('/'))
      return undefined
    return options.publicDirs.map(dir => join(dir, path.slice(1))).find(file => existsSync(file))
  }
}

const brotliCache = new Map<string, number>()

/** Bytes on the wire: the `.br` sidecar kay wrote, else brotli of a compressible file, else the file as it is. */
function servedSize(file: string): number {
  const sidecar = `${file}.br`
  if (existsSync(sidecar))
    return statSync(sidecar).size
  const raw = readFileSync(file)
  if (!COMPRESSED_EXTS.has(extname(file).toLowerCase()))
    return raw.byteLength
  const key = `${file}:${raw.byteLength}`
  let packed = brotliCache.get(key)
  if (packed === undefined) {
    packed = brotliSync(raw, appBrotliCacheDir()).byteLength
    brotliCache.set(key, packed)
  }
  return Math.min(packed, raw.byteLength)
}

// A browser takes the first source of an @font-face it can use, so only that one is fetched; every other url() is.
function cssUrls(css: string): string[] {
  const urls: string[] = []
  const rest = css.replace(FONT_FACE_RE, (face) => {
    const first = new RegExp(CSS_URL_RE.source).exec(face)?.[2]
    if (first !== undefined)
      urls.push(first)
    return ''
  })
  for (const match of rest.matchAll(CSS_URL_RE))
    urls.push(match[2]!)
  for (const match of rest.matchAll(CSS_IMPORT_RE))
    urls.push(match[1]!)
  return urls.filter(url => !SKIPPED_URL_RE.test(url))
}

/** What a file pulls in beside itself: a script's static imports and a stylesheet's `url()`s, as URLs. */
function dependenciesOf(url: string, file: string): string[] {
  const ext = extname(file).toLowerCase()
  if (ext !== '.js' && ext !== '.css')
    return []
  const text = readFileSync(file, 'utf8')
  const base = posix.dirname(url.split(/[?#]/)[0]!)
  const raw = ext === '.js' ? [...text.matchAll(STATIC_CHUNK_IMPORT_RE)].map(m => m[1]!) : cssUrls(text)
  return raw.map(dep => (dep.startsWith('/') ? dep : posix.join(base, dep)))
}

/** Adds up what a first visit fetches from these root URLs and what they pull in; `htmlBytes` is the page itself, brotli; `cacheable` names the URLs served for long caching (kay's hashed assets). */
export function measureFirstLoad(roots: Iterable<string>, locate: Locate, htmlBytes = 0, cacheable: (url: string) => boolean = () => false): FirstLoad {
  const result: FirstLoad = { html: htmlBytes, css: 0, js: 0, fonts: 0, images: 0, other: 0, total: htmlBytes, cached: 0, files: 0 }
  const seen = new Set<string>()
  const stack = [...roots]
  while (stack.length > 0) {
    const url = stack.pop()!
    const file = locate(url)
    if (file === undefined || seen.has(file))
      continue
    seen.add(file)
    const ext = extname(file).toLowerCase()
    const size = servedSize(file)
    if (ext === '.css')
      result.css += size
    else if (ext === '.js' || ext === '.mjs')
      result.js += size
    else if (FONT_EXTS.has(ext))
      result.fonts += size
    else if (IMAGE_EXTS.has(ext))
      result.images += size
    else
      result.other += size
    result.total += size
    if (cacheable(url))
      result.cached += size
    result.files++
    stack.push(...dependenciesOf(url, file))
  }
  return result
}
