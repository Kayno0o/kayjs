import type { Variant } from './sites'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'

// What a browser downloads for one page: its HTML, stylesheets, every script it runs with island chunks and their imports, the fonts its stylesheets can load for Latin text, and its images at each viewport. Text weighs as brotli at quality 11 sends it, images and fonts as served.
export interface Weight {
  html: number
  css: number
  js: number
  jsFiles: number
  fonts: number
  images: Record<string, number>
}

export interface Viewport {
  name: string
  width: number
  dpr: number
}

export const VIEWPORTS: Viewport[] = [{ name: 'desktop', width: 1280, dpr: 1 }, { name: 'phone', width: 390, dpr: 3 }]

const decoder = new TextDecoder()
const STATIC_IMPORT = /(?:\bfrom\s*|\bimport\s*)["']([^"']+\.m?js)["']/g
const CSS_URL = /url\(\s*["']?([^"')\s]+)["']?\s*\)/g
const FONT_FACE = /@font-face\s*\{([^}]*)\}/g
const UNICODE_RANGE = /unicode-range:\s*([^;]+)/
const BASIC_LATIN = /U\+(?:0+-0*FF\b|\?\?(?![\da-f?]))/i
const SIZE_ENTRY = /^(?:\((min|max)-width:\s*(\d+(?:\.\d+)?)(px|rem|em)\)\s+)?(\S.*)$/
const LENGTH = /^(\d+(?:\.\d+)?)(vw|px|rem|em)$/
const ISLAND_CHUNK = /"([^"]+\.kay)":\(\)=>\(\w+\("[^"]*"\),import\("\.\/([^"]+)"\)\)/g
const ROOT_FONT_PX = 16

function brotli(body: Uint8Array): number {
  return brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length
}

// HTMLRewriter hands attribute values over as written, entities included.
function resolve(url: string, base: string): string {
  const resolved = new URL(url.replaceAll('&amp;', '&'), new URL(base, 'http://site'))

  return resolved.origin === 'http://site' ? resolved.pathname + resolved.search : resolved.href
}

// The width in CSS pixels a `sizes` list gives the image at this viewport.
function slotWidth(sizes: string | null, viewport: Viewport): number {
  for (const entry of sizes?.split(',').map(part => part.trim()) ?? []) {
    const [, bound, amount, unit, length] = SIZE_ENTRY.exec(entry) ?? []

    if (!length)
      continue

    if (bound) {
      const limit = Number(amount) * (unit === 'px' ? 1 : ROOT_FONT_PX)

      if (bound === 'min' ? viewport.width < limit : viewport.width > limit)
        continue
    }

    const [, number, lengthUnit] = LENGTH.exec(length) ?? []

    if (!number)
      return viewport.width

    return lengthUnit === 'vw' ? Number(number) / 100 * viewport.width : lengthUnit === 'px' ? Number(number) : Number(number) * ROOT_FONT_PX
  }

  return viewport.width
}

// The candidate a browser picks: the smallest covering the slot at the device pixel ratio, else the widest.
function pickImage(src: string | null, srcset: string | null, sizes: string | null, viewport: Viewport): string | null {
  if (!srcset)
    return src

  const candidates = srcset.split(/,\s+/).map((candidate) => {
    const [url, descriptor = '1x'] = candidate.trim().split(/\s+/)

    return { url: url!, value: Number.parseFloat(descriptor), unit: descriptor.at(-1) }
  }).toSorted((a, b) => a.value - b.value)
  const needed = candidates.every(candidate => candidate.unit === 'x') ? viewport.dpr : slotWidth(sizes, viewport) * viewport.dpr

  return (candidates.find(candidate => candidate.value >= needed) ?? candidates.at(-1)!).url
}

function latinFontUrls(css: string, base: string): string[] {
  const urls: string[] = []

  for (const [, body] of css.matchAll(FONT_FACE)) {
    const range = UNICODE_RANGE.exec(body!)?.[1]

    if (range && !BASIC_LATIN.test(range))
      continue

    const sources = [...body!.matchAll(CSS_URL)].map(([, url]) => url!)
    const file = sources.find(url => url.includes('.woff2')) ?? sources[0]

    if (file)
      urls.push(resolve(file, base))
  }

  return urls
}

// kay's island chunks by component, read from the client build, for the islands that load late and so are not preloaded.
function islandChunks(variant: Variant): Map<string, string> {
  const chunks = new Map<string, string>()

  if (variant.kind === 'astro')
    return chunks

  const dist = join(variant.dir, '.kay/client/dist')

  for (const file of readdirSync(dist).filter(name => name.endsWith('.js'))) {
    for (const [, component, chunk] of readFileSync(join(dist, file), 'utf8').matchAll(ISLAND_CHUNK))
      chunks.set(component!, `/_kay/${chunk}`)
  }

  return chunks
}

export async function weigh(variant: Variant, path: string): Promise<Weight> {
  const get = async (url: string): Promise<Uint8Array<ArrayBuffer>> => {
    const response = await fetch(`http://127.0.0.1:${variant.ports.backend}${url}`, { headers: { accept: 'text/html,image/avif,image/webp,*/*' } })

    if (!response.ok)
      throw new Error(`${variant.dir}: ${url} answered ${response.status}`)

    return new Uint8Array(await response.arrayBuffer())
  }
  const page = await get(path)
  const islands = islandChunks(variant)
  const stylesheets: string[] = []
  const scripts: string[] = []
  const inline: string[] = []
  const images: { src: string | null, srcset: string | null, sizes: string | null }[] = []
  let script: string | undefined

  await new HTMLRewriter()
    .on('link[rel="stylesheet"]', { element: el => void stylesheets.push(resolve(el.getAttribute('href')!, path)) })
    .on('link[rel="modulepreload"]', { element: el => void scripts.push(resolve(el.getAttribute('href')!, path)) })
    .on('script', {
      element(el) {
        const src = el.getAttribute('src')
        const type = el.getAttribute('type')

        if (src) {
          scripts.push(resolve(src, path))
        }
        else if (!type || type === 'module') {
          script = ''
          el.onEndTag(() => {
            inline.push(script!)
            script = undefined
          })
        }
      },
      text(chunk) {
        if (script !== undefined)
          script += chunk.text
      },
    })
    .on('astro-island', { element: el => void scripts.push(...['component-url', 'renderer-url'].map(name => el.getAttribute(name)).filter(url => url !== null).map(url => resolve(url, path))) })
    .on('slot[data-component]', {
      element(el) {
        const chunk = islands.get(el.getAttribute('data-component')!)

        if (chunk)
          scripts.push(chunk)
      },
    })
    .on('img', { element: el => void images.push({ src: el.getAttribute('src'), srcset: el.getAttribute('srcset'), sizes: el.getAttribute('sizes') }) })
    .transform(new Response(page))
    .text()

  const weight: Weight = { html: brotli(page), css: 0, js: 0, jsFiles: 0, fonts: 0, images: {} }
  const queue = [...scripts, ...inline.flatMap(text => [...text.matchAll(STATIC_IMPORT)].map(([, url]) => resolve(url!, path)))]
  const seen = new Set<string>()

  // Scripts, then every module they import statically.
  for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
    if (seen.has(url))
      continue

    seen.add(url)

    const body = await get(url)

    weight.js += brotli(body)
    weight.jsFiles++
    queue.push(...[...decoder.decode(body).matchAll(STATIC_IMPORT)].map(([, imported]) => resolve(imported!, url)))
  }

  const fonts = new Set<string>()

  for (const url of new Set(stylesheets)) {
    const body = await get(url)

    weight.css += brotli(body)
    for (const font of latinFontUrls(decoder.decode(body), url))
      fonts.add(font)
  }
  for (const url of fonts)
    weight.fonts += (await get(url)).length

  for (const viewport of VIEWPORTS) {
    const chosen = new Set(images.map(image => pickImage(image.src, image.srcset, image.sizes, viewport)).filter(url => url !== null && !url.startsWith('data:')).map(url => resolve(url!, path)))

    weight.images[viewport.name] = 0
    for (const url of chosen)
      weight.images[viewport.name]! += (await get(url)).length
  }

  return weight
}
