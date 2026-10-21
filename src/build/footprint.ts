import type { PrerenderedPage } from '../server/client'
import type { RenderedPage } from '../server/page-hook'
import type { Route } from '../server/routes'
import type { Figures } from './footprint-models'
import { extname, join } from 'node:path'
import { MIN_SIZE } from '../server/compress'
import { limiter } from '../server/limit'
import { figuresOf, VIEWPORT_WIDTH } from './footprint-models'
import { gzipSize } from './report'

const REM = 16
const PAGES_AT_ONCE = 8
const IMAGE_TYPES = new Set(['image/avif', 'image/webp', 'image/jpeg', 'image/png', 'image/gif', 'image/svg+xml', 'image/apng'])
const TEXT_EXTENSIONS = new Set(['.css', '.js', '.mjs', '.svg', '.json', '.xml', '.txt', '.html', '.webmanifest'])
const FONT_FACE = /@font-face\s*\{([^}]*)\}/g
const FACE_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')\s]+))\s*\)/
const WHITESPACE = /\s+/
const EVERY_WHITESPACE = /\s+/g
const SRCSET_SEPARATOR = /(?<=\s\d+(?:\.\d+)?[wx])\s*,\s*|,\s+/
const EXTERNAL = /^(?:[a-z][\w+.-]*:|\/\/)/i
const NOT_FETCHED = /^(?:data|blob|javascript|about|mailto|tel):/i
const LENGTH = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem|em|vw|dppx|dpi|x)?$/i
const LENGTH_START = /^[\d.+-]/
// What a `preload` link's `as` loads.
const PRELOAD_KINDS: Record<string, 'css' | 'js' | 'images' | 'fonts'> = { font: 'fonts', script: 'js', style: 'css', image: 'images' }
// The longest `calc()` or media condition read: a deeper one would only be hostile, and nests as deep as it is long.
const MAX_EXPRESSION = 1000
// `width >= 600px`, `600px <= width` or both, `400px <= width <= 700px`; the comparison is read off a condition without its spaces.
const RANGE = /^(?:([^<>=]+)([<>]=?|=))?(width|resolution)(?:([<>]=?|=)([^<>=]+))?$/
const FLIPPED: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '=': '=' }
const FEATURE_NAME = /^[\w-]+$/

// What a page weighs, in the bytes a host serves: text gzipped, an image or a font as the file is.
export interface Footprint extends Figures {
  weight: number
  parts: { html: number, css: number, js: number, images: number, fonts: number }
  requests: number
  dom: number
  // Requests of other origins and of files the build did not make, such as an image made on request, whose weight is not counted.
  unweighed: number
}

// The heaviest page the build has of a route, or none when it has none.
export interface RouteFootprint {
  route: string
  // How many pages of it were measured.
  pages: number
  // The path of the heaviest.
  path?: string | undefined
  footprint?: Footprint | undefined
}

// The file a root-relative URL names, as the build wrote it.
type FileFinder = RenderedPage['file']

interface ImageRef {
  src?: string | undefined
  srcset?: string | undefined
  sizes?: string | undefined
}

interface PictureSource extends ImageRef {
  type?: string | undefined
  media?: string | undefined
}

interface Found {
  dom: number
  scripts: string[]
  styles: string[]
  preloads: { url: string, as: string }[]
  images: (ImageRef & { sources: PictureSource[] })[]
  posters: string[]
  inlineStyles: string[]
}

interface Weighing {
  find: FileFinder
  avif: boolean
  // Gzip or length of each file, once.
  sizes: Map<string, Promise<number>>
  faces: Map<string, Promise<{ url: string, ranged: boolean }[]>>
}

// Reads a page's markup once: its elements, and every URL the browser fetches on the page's load. What a template or a `noscript` holds is no part of the DOM a browser with scripts builds.
async function read(html: string): Promise<Found> {
  const found: Found = { dom: 0, scripts: [], styles: [], preloads: [], images: [], posters: [], inlineStyles: [] }
  // A `template` or `noscript` never closed holds the rest of the page, as it does in a browser, so the count keeps to what a browser would build.
  let inert = 0
  // The `table`s open, each with whether its rows already sit in a `tbody` a browser makes up or the page wrote.
  const tables: { grouped: boolean }[] = []
  const tags = new Set<string>()
  let picture: PictureSource[] | undefined
  let style = ''
  let collecting = false

  const inertElement = (element: HTMLRewriterTypes.Element) => {
    inert++
    element.onEndTag(() => void inert--)
  }

  await new HTMLRewriter()
    .on('*', {
      element: (element) => {
        if (inert > 0)
          return

        found.dom++
        tags.add(element.tagName)
      },
    })
    .on('table', {
      element: (element) => {
        if (inert > 0)
          return

        const table = { grouped: false }

        tables.push(table)
        element.onEndTag(() => void tables.splice(tables.indexOf(table), 1))
      },
    })
    .on('thead, tbody, tfoot', { element: () => void (tables.at(-1) !== undefined && (tables.at(-1)!.grouped = true)) })
    .on('tr', {
      element: () => {
        const table = tables.at(-1)

        // A browser puts a row written straight in a table into a `tbody` of its own.
        if (inert === 0 && table !== undefined && !table.grouped) {
          table.grouped = true
          found.dom++
        }
      },
    })
    .on('template', { element: inertElement })
    .on('noscript', { element: inertElement })
    .on('script[src]', { element: element => void (inert === 0 && found.scripts.push(element.getAttribute('src')!)) })
    .on('link[href]', {
      element: (element) => {
        const rel = new Set((element.getAttribute('rel') ?? '').toLowerCase().split(WHITESPACE))
        const href = element.getAttribute('href')!

        if (inert > 0)
          return

        if (rel.has('stylesheet'))
          found.styles.push(href)
        else if (rel.has('modulepreload'))
          found.scripts.push(href)
        else if (rel.has('preload'))
          found.preloads.push({ url: href, as: (element.getAttribute('as') ?? '').toLowerCase() })
      },
    })
    .on('picture', {
      element: (element) => {
        picture = []
        element.onEndTag(() => void (picture = undefined))
      },
    })
    .on('source', {
      element: (element) => {
        if (inert === 0 && picture !== undefined)
          picture.push({ srcset: element.getAttribute('srcset') ?? undefined, sizes: element.getAttribute('sizes') ?? undefined, type: element.getAttribute('type') ?? undefined, media: element.getAttribute('media') ?? undefined })
      },
    })
    .on('img', {
      element: (element) => {
        if (inert === 0)
          found.images.push({ src: element.getAttribute('src') ?? undefined, srcset: element.getAttribute('srcset') ?? undefined, sizes: element.getAttribute('sizes') ?? undefined, sources: picture ?? [] })
      },
    })
    .on('video[poster]', { element: element => void (inert === 0 && found.posters.push(element.getAttribute('poster')!)) })
    .on('style', {
      element: (element) => {
        style = ''
        collecting = inert === 0
        element.onEndTag(() => void (collecting && found.inlineStyles.push(style)))
      },
      text: (chunk) => {
        if (collecting)
          style += chunk.text
      },
    })
    .transform(new Response(html))
    .arrayBuffer()

  // A browser builds `html`, `head` and `body` for a document that leaves them out.
  for (const implied of ['html', 'head', 'body']) {
    if (!tags.has(implied))
      found.dom++
  }

  return found
}

// Splits at the top level only, so `calc(100vw - 2rem)` and `(min-width: 60rem)` stay whole.
function splitTop(text: string, separator: ',' | ' '): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!

    if (char === '(') {
      depth++
    }
    else if (char === ')') {
      depth--
    }
    else if (depth === 0 && (separator === ' ' ? char === ' ' || char === '\t' || char === '\n' : char === ',')) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }

  parts.push(text.slice(start))

  return parts.map(part => part.trim()).filter(part => part !== '')
}

// A length or a resolution in px, or in dppx for a resolution.
function dimension(text: string, width: number): number | undefined {
  const match = LENGTH.exec(text.trim())

  if (match === null)
    return undefined

  const value = Number(match[1])

  switch ((match[2] ?? '').toLowerCase()) {
    case 'px':
    case '':
    case 'dppx':
    case 'x':
      return value
    case 'rem':
    case 'em':
      return value * REM
    case 'vw':
      return value * width / 100
    case 'dpi':
      return value / 96
    default:
      return undefined
  }
}

// `calc()` over lengths with + - * / and parentheses; undefined for anything else.
function calc(text: string, width: number): number | undefined {
  if (text.length > MAX_EXPRESSION)
    return undefined

  const tokens = text.match(/[\d.]+[a-z%]*|[()+\-*/]/gi) ?? []
  let position = 0
  let sum: () => number | undefined = () => undefined
  const primary = (): number | undefined => {
    const token = tokens[position++]

    if (token === '(') {
      const inner = sum()

      position++

      return inner
    }

    if (token === '-') {
      const operand = primary()

      return operand === undefined ? undefined : -operand
    }

    return token === undefined ? undefined : dimension(token, width)
  }
  const product = (): number | undefined => {
    let value = primary()

    while (tokens[position] === '*' || tokens[position] === '/') {
      const operator = tokens[position++]
      const next = primary()

      if (value === undefined || next === undefined)
        return undefined

      value = operator === '*' ? value * next : value / next
    }

    return value
  }

  sum = (): number | undefined => {
    let value = product()

    while (tokens[position] === '+' || tokens[position] === '-') {
      const operator = tokens[position++]
      const next = product()

      if (value === undefined || next === undefined)
        return undefined

      value = operator === '+' ? value + next : value - next
    }

    return value
  }

  return sum()
}

function lengthOf(text: string, width: number): number | undefined {
  const trimmed = text.trim()

  if (trimmed.toLowerCase().startsWith('calc('))
    return calc(trimmed.slice(5, -1), width)

  return LENGTH_START.test(trimmed) ? dimension(trimmed, width) : undefined
}

// A parenthesized `(name: value)` as its name and value.
function propertyOf(part: string): [string, string] | undefined {
  const colon = part.indexOf(':')

  if (!part.startsWith('(') || !part.endsWith(')') || colon === -1)
    return undefined

  const name = part.slice(1, colon).trim()

  return FEATURE_NAME.test(name) ? [name, part.slice(colon + 1, -1).trim()] : undefined
}

function combine(left: boolean, operator: string, right: boolean): boolean {
  return operator === 'and' ? left && right : left || right
}

// A media condition for a window `width` wide at one device pixel per CSS pixel: width and resolution features, `and`, `or`, `not` and parentheses; any other feature does not match.
function matches(condition: string, width: number): boolean {
  if (condition.length > MAX_EXPRESSION)
    return false

  const parts = splitTop(condition.trim(), ' ')
  let negated = false
  let result: boolean | undefined
  let operator = 'and'

  for (const part of parts) {
    const word = part.toLowerCase()

    if (word === 'only') {
      continue
    }
    else if (word === 'not') {
      negated = true
    }
    else if (word === 'and' || word === 'or') {
      operator = word
    }
    else {
      const next = negated ? !conditionHolds(part, width) : conditionHolds(part, width)

      negated = false
      result = result === undefined ? next : combine(result, operator, next)
    }
  }

  return result ?? true
}

// A media type word, a `(feature: value)`, a range such as `(width >= 600px)` or a parenthesized condition.
function conditionHolds(part: string, width: number): boolean {
  const word = part.toLowerCase()

  if (word === 'all' || word === 'screen')
    return true

  const single = propertyOf(part)

  if (single !== undefined)
    return feature(single[0].toLowerCase(), single[1], width)

  if (!part.startsWith('(') || !part.endsWith(')'))
    return false

  const inner = part.slice(1, -1).trim()
  const range = RANGE.exec(inner.toLowerCase().replaceAll(EVERY_WHITESPACE, ''))

  if (range === null || (range[1] === undefined && range[4] === undefined))
    return matches(inner, width)

  // A value on the left reads the other way round: `600px <= width` is `width >= 600px`.
  return (range[1] === undefined || compare(range[3]!, FLIPPED[range[2]!]!, range[1], width)) && (range[4] === undefined || compare(range[3]!, range[4], range[5]!, width))
}

function compare(name: string, operator: string, value: string, width: number): boolean {
  const limit = name === 'width' ? lengthOf(value, width) : dimension(value, width)

  if (limit === undefined)
    return false

  const actual = name === 'width' ? width : 1

  switch (operator) {
    case '>=': return actual >= limit
    case '>': return actual > limit
    case '<=': return actual <= limit
    case '<': return actual < limit
    default: return actual === limit
  }
}

// A `media` attribute: queries separated by commas, any of which may hold; none at all holds.
function mediaHolds(media: string, width: number): boolean {
  const queries = splitTop(media, ',')

  return queries.length === 0 || queries.some(query => matches(query, width))
}

function feature(name: string, value: string, width: number): boolean {
  const number = name.endsWith('resolution') ? dimension(value, width) : lengthOf(value, width)

  if (number === undefined)
    return false

  switch (name) {
    case 'min-width':
    case 'width':
      return name === 'width' ? width === number : width >= number
    case 'max-width':
      return width <= number
    case 'min-resolution':
      return number <= 1
    case 'max-resolution':
      return number >= 1
    default:
      return false
  }
}

// The width the image takes in a window `width` wide: the first `sizes` entry whose condition holds, else the whole window.
function slotWidth(sizes: string | undefined, width: number): number {
  for (const entry of splitTop(sizes ?? '', ',')) {
    const parts = splitTop(entry, ' ')
    const length = parts.pop()
    const slot = length === undefined ? undefined : lengthOf(length, width)

    if (slot !== undefined && (parts.length === 0 || matches(parts.join(' '), width)))
      return slot
  }

  return width
}

// The URL a browser picks from a `srcset` at one device pixel per CSS pixel: the narrowest candidate at least as wide as the slot, else the widest; of densities, the lowest at 1x or more.
export function pickImage({ src, srcset, sizes }: ImageRef, width = VIEWPORT_WIDTH): string | undefined {
  const candidates = srcset === undefined
    ? []
    : srcset.split(SRCSET_SEPARATOR).flatMap((candidate) => {
      const [url, descriptor = '1x'] = candidate.trim().split(WHITESPACE)
      const value = Number.parseFloat(descriptor)

      return url === undefined || url === '' || !Number.isFinite(value) ? [] : [{ url, value, wide: descriptor.endsWith('w') }]
    })

  if (candidates.length === 0)
    return src

  const wide = candidates.some(candidate => candidate.wide)
  const needed = wide ? slotWidth(sizes, width) : 1
  const fitting = candidates.filter(candidate => candidate.wide === wide).toSorted((a, b) => a.value - b.value)

  return (fitting.find(candidate => candidate.value >= needed) ?? fitting.at(-1))?.url ?? src
}

// The URL a browser loads for an `img`: a `picture`'s first `source` it can use, else the `img` itself.
function imageUrl(image: Found['images'][number], width: number): string | undefined {
  for (const source of image.sources) {
    if (source.srcset !== undefined && (source.type === undefined || IMAGE_TYPES.has(source.type.toLowerCase())) && (source.media === undefined || mediaHolds(source.media, width)))
      return pickImage(source, width)
  }

  return pickImage(image, width)
}

function unescaped(url: string): string {
  return url.trim().replaceAll('&amp;', '&')
}

// The gzip copy `kay build` wrote beside a text file is what a host serves, so its size is read rather than compressing again; a file with no copy, or whose copy is older than it, is compressed here, and served as it is when the build would have kept no copy: under the least size, or saving less than a tenth.
async function gzippedSize(file: string, bytes: () => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>): Promise<number> {
  const copy = Bun.file(`${file}.gz`)

  if (await copy.exists() && copy.lastModified >= Bun.file(file).lastModified)
    return copy.size

  const content = await bytes()
  const gzipped = gzipSize(content)

  return content.length >= MIN_SIZE && gzipped < content.length * 0.9 ? gzipped : content.length
}

async function measured(file: string): Promise<number> {
  if (TEXT_EXTENSIONS.has(extname(file).toLowerCase()))
    return gzippedSize(file, async () => Bun.file(file).bytes())

  return Bun.file(file).size
}

// Each file is measured once, gzipped when a host compresses it.
async function sizeOf(file: string, weighing: Weighing): Promise<number> {
  let size = weighing.sizes.get(file)

  if (size === undefined) {
    size = measured(file)
    weighing.sizes.set(file, size)
  }

  return size
}

async function facesIn(file: string): Promise<{ url: string, ranged: boolean }[]> {
  return facesOf(await Bun.file(file).text())
}

// A stylesheet's font files, the face's range noted: a face with a `unicode-range` is a subset the browser fetches only when the text needs it.
function facesOf(css: string): { url: string, ranged: boolean }[] {
  return [...css.matchAll(FONT_FACE)].flatMap(([, body]) => {
    const match = FACE_URL.exec(body!)
    const url = match?.[1] ?? match?.[2] ?? match?.[3]

    return url === undefined ? [] : [{ url, ranged: body!.includes('unicode-range') }]
  })
}

// The variant a browser that reads AVIF is sent, when `kay build` made one beside the WebP.
async function negotiated(file: string, weighing: Weighing): Promise<string> {
  if (!weighing.avif || !file.endsWith('.webp'))
    return file

  const avif = `${file.slice(0, -5)}.avif`

  return await Bun.file(avif).exists() ? avif : file
}

// Reads a page's HTML for what a browser fetches on loading it and counts its DOM elements and requests, then weighs the files: its HTML, the stylesheets and scripts it links, the image its `srcset` picks at the window's width, the fonts it preloads or declares without ranges.
// Lazy images count, as a visitor who scrolls loads them; the chunks an island fetches on interaction, a file a stylesheet names but a font, the favicon and media do not.
export async function measurePage(html: string, path: string, weighing: Weighing, htmlFile?: string, width = VIEWPORT_WIDTH): Promise<Footprint> {
  const found = await read(html)
  const here = `http://localhost${path}`
  const parts: Footprint['parts'] = { html: htmlFile === undefined ? gzipSize(new TextEncoder().encode(html)) : await gzippedSize(htmlFile, () => new TextEncoder().encode(html)), css: 0, js: 0, images: 0, fonts: 0 }
  const fetched = new Set<string>()
  const preloadedFonts = new Set<string>()
  let unweighed = 0
  let requests = 1
  const fetchOf = async (raw: string, kind: 'css' | 'js' | 'images' | 'fonts'): Promise<{ file?: string, url: string } | undefined> => {
    const text = unescaped(raw)

    if (text === '' || NOT_FETCHED.test(text))
      return undefined

    if (EXTERNAL.test(text)) {
      if (!fetched.has(text)) {
        fetched.add(text)
        requests++
        unweighed++
      }

      return undefined
    }

    const resolved = URL.parse(text, here)

    if (resolved === null)
      return undefined

    const url = `${resolved.pathname}${resolved.search}`

    if (fetched.has(url))
      return undefined

    fetched.add(url)
    requests++

    const file = await weighing.find(url)

    if (file === undefined) {
      unweighed++

      return undefined
    }

    const target = kind === 'images' ? await negotiated(file, weighing) : file

    parts[kind] += await sizeOf(target, weighing)

    return { file: target, url }
  }

  for (const preload of found.preloads) {
    if (preload.as === 'font')
      preloadedFonts.add(URL.parse(unescaped(preload.url), here)?.pathname ?? '')
  }

  for (const url of found.scripts)
    await fetchOf(url, 'js')

  const stylesheets: string[] = []

  for (const url of found.styles) {
    const fetchedFile = await fetchOf(url, 'css')

    if (fetchedFile?.file !== undefined)
      stylesheets.push(fetchedFile.file)
  }

  for (const preload of found.preloads) {
    const kind = PRELOAD_KINDS[preload.as]

    if (kind !== undefined)
      await fetchOf(preload.url, kind)
  }

  const faces = found.inlineStyles.flatMap(facesOf)

  for (const file of stylesheets) {
    let each = weighing.faces.get(file)

    if (each === undefined) {
      each = facesIn(file)
      weighing.faces.set(file, each)
    }

    faces.push(...await each)
  }

  for (const face of faces) {
    if (!face.ranged || preloadedFonts.has(URL.parse(unescaped(face.url), here)?.pathname ?? ''))
      await fetchOf(face.url, 'fonts')
  }

  for (const image of found.images) {
    const url = imageUrl(image, width)

    if (url !== undefined)
      await fetchOf(url, 'images')
  }

  for (const poster of found.posters)
    await fetchOf(poster, 'images')

  const weight = Object.values(parts).reduce((sum, bytes) => sum + bytes, 0)

  return { weight, parts, requests, dom: found.dom, unweighed, ...figuresOf({ dom: found.dom, requests, bytes: weight }) }
}

export function weighing(find: FileFinder, avif: boolean): Weighing {
  return { find, avif, sizes: new Map(), faces: new Map() }
}

// Each route's heaviest page among the prerendered ones, read from the files the build wrote, so a page hook's changes count. A route none of whose pages was prerendered has none: a server renders it per request, and a route with params has the pages its `prerender` lists.
export async function routeFootprints(dir: string, pages: Map<string, PrerenderedPage>, routes: Route[], find: FileFinder, avif: boolean): Promise<RouteFootprint[]> {
  const context = weighing(find, avif)
  const reading = limiter(PAGES_AT_ONCE)
  const byRoute = Map.groupBy(pages, ([, page]) => page.pattern)
  const patterns = [...new Set(routes.map(route => route.pattern))]

  return Promise.all(patterns.map(async (route) => {
    const own = byRoute.get(route) ?? []
    const measured = (await Promise.all(own.map(async ([path, page]) => reading(async () => {
      const file = join(dir, page.file)

      try {
        return { path, footprint: await measurePage(await Bun.file(file).text(), path, context, file) }
      }
      catch {
        // A page that cannot be read is left out, as a report must not fail the build.
        return undefined
      }
    })))).filter(each => each !== undefined)
    const heaviest = measured.reduce<(typeof measured)[number] | undefined>((most, each) => most === undefined || each.footprint.weight > most.footprint.weight ? each : most, undefined)

    return { route, pages: own.length, path: heaviest?.path, footprint: heaviest?.footprint }
  }))
}
