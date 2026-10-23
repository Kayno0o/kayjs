import type { KayExtension } from 'kay/server'
import { brotliCompress, constants } from 'node:zlib'

const SLOT = '<span data-page-weight></span>'
const TAG = /<(img|script|link)\b[^>]*>/g
const SRC = /\bsrc="([^"]+)"/
const HREF = /\bhref="([^"]+)"/
const REL = /\brel="([^"]+)"/
const TYPE = /\btype="([^"]+)"/
const QUICK_QUALITY = 5
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

// Off the main thread, so the pages the build hooks at once compress in parallel.
async function quickSize(input: string): Promise<number> {
  return new Promise((resolve, reject) => brotliCompress(input, { params: { [constants.BROTLI_PARAM_QUALITY]: QUICK_QUALITY } }, (error, result) => error ? reject(error) : resolve(result.length)))
}

const line = (bytes: number) => `<span data-page-weight>This page: ${(bytes / 1024).toFixed(1)} KB.</span>`

// Fills the footer's slot with what a first visit downloads as served: the page and every file it fetches, each once. The files' sizes and the page's come from kay's own copies, which the compress stage finds again.
export const pageWeight: KayExtension = {
  name: 'page-weight',
  async transformPage({ html, fileSize, htmlSize }) {
    if (!html.includes(SLOT))
      return html

    const sizes = await Promise.all([...linkedUrls(html)].map(async url => fileSize(url)))
    const linked = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0)
    // A quick brotli only picks the digits; the page is measured at full strength once, with the line in place, which it adds a few bytes to.
    const quick = await quickSize(html)
    const full = await htmlSize(html.replace(SLOT, () => line(quick + linked)))

    return html.replace(SLOT, () => line(full + linked))
  },
}
