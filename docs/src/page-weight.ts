import type { KayPlugin } from '@kayjs/kay/config'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'

const BROTLI_OPTS = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } }
const SLOT_RE = /<span\b[^>]*\bdata-page-weight(?:="")?[^>]*><\/span>/
const TAG_RE = /<(img|script|link)\b[^>]*>/g
const SRC_RE = /\bsrc="([^"]+)"/
const HREF_RE = /\bhref="([^"]+)"/
const REL_RE = /\brel="([^"]+)"/
const TYPE_RE = /\btype="([^"]+)"/
const COMPRESSED_RE = /\.(?:css|m?js|svg|json|xml|txt|html)$/
const FETCHED_RELS = new Set(['stylesheet', 'modulepreload'])
const JS_TYPES = new Set(['module', 'text/javascript'])

function linkedUrls(html: string): { urls: Set<string>, javascript: boolean } {
  const urls = new Set<string>()
  let javascript = false
  for (const [el, name] of html.matchAll(TAG_RE)) {
    if (name === 'link') {
      const url = HREF_RE.exec(el)?.[1]
      const rel = REL_RE.exec(el)?.[1] ?? ''
      if (url && (rel === 'icon' || FETCHED_RELS.has(rel)))
        urls.add(url)
      continue
    }
    if (name === 'script') {
      const t = TYPE_RE.exec(el)?.[1]
      javascript ||= t === undefined || JS_TYPES.has(t)
    }
    const url = SRC_RE.exec(el)?.[1]
    if (url)
      urls.add(url)
  }
  return { urls, javascript }
}

export function pageWeight(): KayPlugin {
  let rootDir = ''
  let outDir = ''
  let assetPrefix = '/_kay'
  const cache = new Map<string, number>()

  async function servedSize(path: string): Promise<number> {
    const hit = cache.get(path)
    if (hit !== undefined)
      return hit
    const bytes = await Bun.file(path).bytes()
    const size = COMPRESSED_RE.test(path) ? brotliCompressSync(bytes, BROTLI_OPTS).length : bytes.length
    cache.set(path, size)
    return size
  }

  function resolveUrl(url: string): string | undefined {
    if (!outDir || !url.startsWith('/'))
      return undefined
    if (url.startsWith(`${assetPrefix}/`)) {
      const f = join(outDir, 'client', url.slice(assetPrefix.length + 1))
      return existsSync(f) ? f : undefined
    }
    const pub = join(outDir, 'public', url.slice(1))
    if (existsSync(pub))
      return pub
    if (rootDir) {
      const srcPub = join(rootDir, 'public', url.slice(1))
      if (existsSync(srcPub))
        return srcPub
    }
    return undefined
  }

  return {
    name: 'docs-page-weight',
    build(ctx) {
      rootDir = ctx.root
      outDir = ctx.outDir
      assetPrefix = ctx.assetPrefix
      cache.clear()
    },
    async transformHtml(html) {
      if (!SLOT_RE.test(html))
        return html
      const { urls, javascript } = linkedUrls(html)
      const paths = [...urls].map(resolveUrl).filter((p): p is string => p !== undefined)
      const linked = (await Promise.all(paths.map(servedSize))).reduce((a, b) => a + b, 0)
      const format = (bytes: number) =>
        `<span class="docs-weight" data-page-weight>This page: ${(bytes / 1024).toFixed(1)} KB${javascript ? '' : ', no JavaScript'}.</span>`
      const est = html.replace(SLOT_RE, () => format(brotliCompressSync(html, BROTLI_OPTS).length + linked))
      return html.replace(SLOT_RE, () => format(brotliCompressSync(est, BROTLI_OPTS).length + linked))
    },
  }
}
