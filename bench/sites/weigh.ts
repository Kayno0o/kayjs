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
// One media feature of an entry's condition, in as many parentheses as it comes, joined to the next by `and`: kay writes `(min-resolution: 3dppx) and ((min-width: 1024px))`.
const CONDITION = /^\(+\s*(min|max)-(width|resolution)\s*:\s*(\d+(?:\.\d+)?)(px|rem|em|dppx|x)?\s*\)+\s*(?:and\s+)?/
// A token of a length: a number with its unit, an operator, a parenthesis, a comma or a function's name.
const LENGTH_TOKEN = /\s*(\d+(?:\.\d+)?(?:vw|px|rem|em)?|[-+*/(),]|calc|min|max)/y
const ISLAND_CHUNK = /"([^"]+\.kay)":\(\)=>\(\w+\("[^"]*"\),import\("\.\/([^"]+)"\)\)/g
const NUMBER = /^[\d.]+/
const SRCSET_SEPARATOR = /,\s+/
const WHITESPACE = /\s+/
const ROOT_FONT_PX = 16

function brotli(body: Uint8Array): number {
  return brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length
}

// A page's inline scripts, and its brotli weight split between its markup and those scripts: what they add to the page's brotli is JS, the rest HTML. JSON-LD and other data blocks stay HTML.
export async function splitInlineScripts(page: Uint8Array<ArrayBuffer>): Promise<{ html: number, js: number, scripts: string[] }> {
  const scripts: string[] = []
  let script: string | undefined

  const markup = await new HTMLRewriter()
    .on('script', {
      element(el) {
        const src = el.getAttribute('src')
        const type = el.getAttribute('type')

        if ((src === null || src === '') && (type === null || type === '' || type === 'module')) {
          script = ''
          el.onEndTag(() => {
            scripts.push(script!)
            script = undefined
          })
        }
      },
      text(chunk) {
        if (script === undefined)
          return

        script += chunk.text
        chunk.remove()
      },
    })
    .transform(new Response(page))
    .bytes()
  const html = brotli(markup)

  return { html, js: scripts.some(text => text.trim() !== '') ? brotli(page) - html : 0, scripts }
}

// HTMLRewriter hands attribute values over as written, entities included.
function resolve(url: string, base: string): string {
  const resolved = new URL(url.replaceAll('&amp;', '&'), new URL(base, 'http://site'))

  return resolved.origin === 'http://site' ? resolved.pathname + resolved.search : resolved.href
}

// A `sizes` list's entries, split on the commas outside parentheses, which `min(100vw, 30rem)` holds.
function entriesOf(sizes: string): string[] {
  const entries: string[] = []
  let depth = 0
  let start = 0

  for (const [index, char] of [...sizes].entries()) {
    if (char === '(')
      depth++
    else if (char === ')')
      depth--

    if (char === ',' && depth === 0) {
      entries.push(sizes.slice(start, index).trim())
      start = index + 1
    }
  }

  return [...entries, sizes.slice(start).trim()]
}

// Whether the media features leading an entry all hold at this viewport, and the length after them; undefined for a condition it does not read.
function condition(entry: string, viewport: Viewport): { holds: boolean, length: string } | undefined {
  let rest = entry
  let holds = true

  for (let match = CONDITION.exec(rest); match; match = CONDITION.exec(rest)) {
    const [whole, bound, feature, amount, unit] = match
    const actual = feature === 'width' ? viewport.width : viewport.dpr
    const limit = Number(amount) * (unit === 'rem' || unit === 'em' ? ROOT_FONT_PX : 1)

    holds &&= bound === 'min' ? actual >= limit : actual <= limit
    rest = rest.slice(whole.length)
  }

  return rest.startsWith('(') ? undefined : { holds, length: rest }
}

// Reads a length's tokens left to right: sums of products of terms, a term being a number with its unit or a parenthesised `calc`, `min` or `max`.
class LengthReader {
  private at = 0

  constructor(private readonly tokens: string[], private readonly viewport: Viewport) {}

  read(): number | undefined {
    const value = this.sum()

    return this.at === this.tokens.length && Number.isFinite(value) ? value : undefined
  }

  private take(): string | undefined {
    return this.tokens[this.at++]
  }

  private sum(): number {
    let value = this.product()

    while (this.tokens[this.at] === '+' || this.tokens[this.at] === '-')
      value = this.take() === '+' ? value + this.product() : value - this.product()

    return value
  }

  private product(): number {
    let value = this.term()

    while (this.tokens[this.at] === '*' || this.tokens[this.at] === '/')
      value = this.take() === '*' ? value * this.term() : value / this.term()

    return value
  }

  private term(): number {
    const token = this.take()

    if (token === '(' || token === 'calc' || token === 'min' || token === 'max') {
      if (token !== '(' && this.take() !== '(')
        return Number.NaN

      const values = [this.sum()]

      while (this.tokens[this.at] === ',') {
        this.take()
        values.push(this.sum())
      }

      if (this.take() !== ')')
        return Number.NaN

      if (token === 'min')
        return Math.min(...values)

      return token === 'max' ? Math.max(...values) : values[0]!
    }

    const number = Number.parseFloat(token ?? '')
    const unit = token?.replace(NUMBER, '')

    if (unit === 'vw')
      return number / 100 * this.viewport.width

    return unit === 'rem' || unit === 'em' ? number * ROOT_FONT_PX : number
  }
}

// A length in CSS pixels at this viewport: units, `calc`, `min` and `max`, or undefined for one it does not read.
function lengthOf(text: string, viewport: Viewport): number | undefined {
  const tokens: string[] = []
  let read = 0

  LENGTH_TOKEN.lastIndex = 0

  // A failed match sets `lastIndex` back to 0, so how far the tokens reached is kept apart.
  for (let match = LENGTH_TOKEN.exec(text); match; match = LENGTH_TOKEN.exec(text)) {
    tokens.push(match[1]!)
    read = LENGTH_TOKEN.lastIndex
  }

  return text.slice(read).trim() === '' ? new LengthReader(tokens, viewport).read() : undefined
}

// The width in CSS pixels a `sizes` list gives the image at this viewport: the length of the first entry whose condition holds, the viewport's width for one it cannot read.
export function slotWidth(sizes: string | null, viewport: Viewport): number {
  for (const entry of sizes === null ? [] : entriesOf(sizes)) {
    const read = condition(entry, viewport)

    if (read?.holds === false || read?.length === '')
      continue

    return (read && lengthOf(read.length, viewport)) ?? viewport.width
  }

  return viewport.width
}

// The candidate a browser picks: the smallest covering the slot at the device pixel ratio, else the widest.
export function pickImage(src: string | null, srcset: string | null, sizes: string | null, viewport: Viewport): string | null {
  if (srcset === null || srcset === '')
    return src

  const candidates = srcset.split(SRCSET_SEPARATOR).map((candidate) => {
    const [url, descriptor = '1x'] = candidate.trim().split(WHITESPACE)

    return { url: url!, value: Number.parseFloat(descriptor), unit: descriptor.at(-1) }
  }).toSorted((a, b) => a.value - b.value)
  const needed = candidates.every(candidate => candidate.unit === 'x') ? viewport.dpr : slotWidth(sizes, viewport) * viewport.dpr

  return (candidates.find(candidate => candidate.value >= needed) ?? candidates.at(-1)!).url
}

export function latinFontUrls(css: string, base: string): string[] {
  const urls: string[] = []

  for (const [, body] of css.matchAll(FONT_FACE)) {
    const range = UNICODE_RANGE.exec(body!)?.[1]

    if (range !== undefined && range !== '' && !BASIC_LATIN.test(range))
      continue

    const sources = [...body!.matchAll(CSS_URL)].map(([, url]) => url!)
    const file = sources.find(url => url.includes('.woff2')) ?? sources[0]

    if (file !== undefined && file !== '')
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

// `auth` holds what the variant's site has every request carry, as a session cookie.
export async function weigh(variant: Variant, path: string, auth: Record<string, string> = {}): Promise<Weight> {
  const get = async (url: string): Promise<Uint8Array<ArrayBuffer>> => {
    const response = await fetch(`http://127.0.0.1:${variant.ports.backend}${url}`, { headers: { ...auth, accept: 'text/html,image/avif,image/webp,*/*' } })

    if (!response.ok)
      throw new Error(`${variant.dir}: ${url} answered ${response.status}`)

    return new Uint8Array(await response.arrayBuffer())
  }
  const page = await get(path)
  const islands = islandChunks(variant)
  const stylesheets: string[] = []
  const scripts: string[] = []
  const images: { src: string | null, srcset: string | null, sizes: string | null }[] = []
  const inline = await splitInlineScripts(page)

  await new HTMLRewriter()
    .on('link[rel="stylesheet"]', { element: el => void stylesheets.push(resolve(el.getAttribute('href')!, path)) })
    .on('link[rel="modulepreload"]', { element: el => void scripts.push(resolve(el.getAttribute('href')!, path)) })
    .on('script[src]:not([src=""])', { element: el => void scripts.push(resolve(el.getAttribute('src')!, path)) })
    .on('astro-island', { element: el => void scripts.push(...['component-url', 'renderer-url'].map(name => el.getAttribute(name)).filter(url => url !== null).map(url => resolve(url, path))) })
    .on('slot[data-component]', {
      element(el) {
        const chunk = islands.get(el.getAttribute('data-component')!)

        if (chunk !== undefined && chunk !== '')
          scripts.push(chunk)
      },
    })
    .on('img', { element: el => void images.push({ src: el.getAttribute('src'), srcset: el.getAttribute('srcset'), sizes: el.getAttribute('sizes') }) })
    .transform(new Response(page))
    .text()

  const weight: Weight = { html: inline.html, css: 0, js: inline.js, jsFiles: 0, fonts: 0, images: {} }
  const queue = [...scripts, ...inline.scripts.flatMap(text => [...text.matchAll(STATIC_IMPORT)].map(([, url]) => resolve(url!, path)))]
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

  // kay writes its @font-face rules in the head rather than a stylesheet.
  const fonts = new Set(latinFontUrls(decoder.decode(page), path))

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
