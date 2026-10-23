import type { KayExtension } from 'kay/server'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { brotliCompress, constants } from 'node:zlib'

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

// Off the main thread, so the pages the build hooks at once compress in parallel; strongest unless a quality is given.
async function brotliSize(input: string | Uint8Array, quality?: number): Promise<number> {
  return new Promise((resolve, reject) => brotliCompress(input, quality === undefined ? {} : { params: { [constants.BROTLI_PARAM_QUALITY]: quality } }, (error, result) => error ? reject(error) : resolve(result.length)))
}

// Sizes are kept between builds, named by what they measured: the same bytes brotli compresses to the same length, so a build that changed nothing measures nothing. Bun's version is in the folder's name, as the encoder is its.
const SIZES = join(import.meta.dir, '..', '.kay', 'cache', 'page-weight', Bun.version)
let sizesMade: Promise<unknown> | undefined

async function keptSize(key: string): Promise<number | undefined> {
  const file = Bun.file(join(SIZES, key))

  if (!await file.exists())
    return undefined

  // A file another page is still writing reads short or empty: it is measured again.
  const size = Number(await file.text())

  return Number.isSafeInteger(size) && size > 0 ? size : undefined
}

// A folder that cannot be written costs the next build its measuring, never this one.
async function keepSize(key: string, size: number): Promise<number> {
  try {
    await (sizesMade ??= mkdir(SIZES, { recursive: true }))
    await Bun.write(join(SIZES, key), String(size))
  }
  catch {}

  return size
}

async function sizeOf(key: string, measure: () => Promise<number>): Promise<number> {
  return await keptSize(key) ?? keepSize(key, await measure())
}

// Most pages link the same stylesheets and scripts: each is measured once per version of it rather than once per page, brotli at its strongest costing tens of milliseconds a file.
const measured = new Map<string, Promise<number>>()

// Text goes out brotli, as the static build precompresses it; an image or an icon goes out as it is.
async function measure(path: string): Promise<number> {
  const bytes = await Bun.file(path).bytes()

  return COMPRESSED.test(path) ? sizeOf(`file-${Bun.hash(bytes)}`, async () => brotliSize(bytes)) : bytes.length
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

// A quick brotli only picks the digits; the page is measured at full strength once, with the line in place, which it adds a few bytes to.
async function fullSize(html: string, linked: number): Promise<number> {
  const quick = await brotliSize(html, 5)

  return brotliSize(html.replace(SLOT, () => line(quick + linked)))
}

// Fills the footer's slot with what a first visit downloads as served: the page and every file it fetches, each once.
export const pageWeight: KayExtension = {
  name: 'page-weight',
  async transformPage({ html, file }) {
    if (!html.includes(SLOT))
      return html

    const paths = await Promise.all([...linkedUrls(html)].map(async url => file(url)))
    const sizes = await Promise.all(paths.filter(path => path !== undefined).map(async path => servedSize(path)))
    const linked = sizes.reduce((sum, size) => sum + size, 0)
    const full = await sizeOf(`page-${Bun.hash(html)}-${html.length}-${linked}`, async () => fullSize(html, linked))

    return html.replace(SLOT, () => line(full + linked))
  },
}
