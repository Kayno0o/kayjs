import type { KayExtension } from 'kay/server'
import { brotliCompressSync, constants } from 'node:zlib'

const SLOT = '<span data-page-weight></span>'
const TAG = /<(img|script|link)\b[^>]*>/g
const SRC = /\bsrc="([^"]+)"/
const HREF = /\bhref="([^"]+)"/
const REL = /\brel="([^"]+)"/
const TYPE = /\btype="([^"]+)"/
const COMPRESSED = /\.(?:css|m?js|svg|json|xml|txt|html)$/
// What a browser fetches on a first visit; touch icons, the manifest and feeds wait for the visitor to ask.
const FETCHED_RELS = new Set(['stylesheet', 'modulepreload'])

function linkedUrls(html: string): Set<string> {
  const urls = new Set<string>()
  const icons: string[] = []
  let svgIcon: string | undefined

  for (const [element, name] of html.matchAll(TAG)) {
    if (name === 'link') {
      const url = HREF.exec(element)?.[1]
      const relation = REL.exec(element)?.[1] ?? ''

      if (url !== undefined && relation === 'icon') {
        icons.push(url)
        svgIcon ??= TYPE.exec(element)?.[1] === 'image/svg+xml' ? url : undefined
      }
      else if (url !== undefined && FETCHED_RELS.has(relation)) {
        urls.add(url)
      }

      continue
    }

    const url = SRC.exec(element)?.[1]

    if (url !== undefined)
      urls.add(url)
  }

  // A browser drawing SVG icons fetches the SVG one alone; the others are for browsers that do not.
  for (const icon of svgIcon === undefined ? icons : [svgIcon])
    urls.add(icon)

  return urls
}

// Most pages link the same stylesheets and scripts: each is measured once per version of it rather than once per page, brotli at its strongest costing tens of milliseconds a file.
const measured = new Map<string, Promise<number>>()

// Text goes out brotli, as the static build precompresses it; an image or an icon goes out as it is.
async function measure(path: string): Promise<number> {
  const bytes = await Bun.file(path).bytes()

  return COMPRESSED.test(path) ? brotliCompressSync(bytes).length : bytes.length
}

async function servedSize(path: string): Promise<number> {
  const key = `${path}:${Bun.file(path).lastModified}`
  let size = measured.get(key)

  if (size === undefined) {
    size = measure(path)
    measured.set(key, size)
  }

  return size
}

const line = (bytes: number) => `<span data-page-weight>This page: ${(bytes / 1024).toFixed(1)} KB.</span>`

// Fills the footer's slot with what a first visit downloads as served: the page and every file it fetches, each once.
export const pageWeight: KayExtension = {
  name: 'page-weight',
  async transformPage({ html, file }) {
    if (!html.includes(SLOT))
      return html

    const paths = await Promise.all([...linkedUrls(html)].map(async url => file(url)))
    const sizes = await Promise.all(paths.filter(path => path !== undefined).map(async path => servedSize(path)))
    const linked = sizes.reduce((sum, size) => sum + size, 0)
    // A quick brotli only picks the digits; the page is measured at full strength once, with the line in place, which it adds a few bytes to.
    const estimate = html.replace(SLOT, () => line(brotliCompressSync(html, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length + linked))

    return html.replace(SLOT, () => line(brotliCompressSync(estimate).length + linked))
  },
}
