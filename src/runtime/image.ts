import { kayLog } from './log'
// The widths an image is resized to unless `images.widths` says otherwise, the only ones the image route makes: a fixed ladder keeps how many files one image can turn into bounded.
export const IMAGE_WIDTHS = [320, 640, 960, 1280, 1920, 2560, 3840] as const
// The most widths `images.widths` may list, and the widest of them.
export const MOST_WIDTHS = 16
export const WIDEST = 16384
// Below the ladder, the route also makes the multiples of this, for an image drawn at a fixed width: still a bounded number of files, none much wider than drawn.
export const SMALL_STEP = 16
// A `sizes` that is one length in pixels; `rem` and `em` follow the font size.
const FIXED_SIZE = /^\s*(\d+(?:\.\d+)?)px\s*$/i
// The densities an image drawn at a fixed width gets variants for when `images.maxDensity` leaves the browser's choice.
const UNCAPPED_DENSITY = 3

export const IMAGE_ROUTE = '/_kay/image'
export const CARD_ROUTE = '/_kay/card'
// Where imported images are served, and the variants `kay build` writes of them.
export const IMPORTED = '/_kay/assets/'
export const VARIANTS = '/_kay/images/'
// Where stored files are served. An image's key holds its size, `avatars/1f3a.1600x1200.jpg`, so a page sizes it without reading it.
export const FILES_ROUTE = '/_kay/files/'
const STORED_SIZE = /\.(\d{1,5})x(\d{1,5})\.[a-z\d]+(?:\?.*)?$/i
const EXTENSION = /\.[^.]+$/
const QUERY = /\?.*$/
const FUNCTION_NAME = /[a-z-]*$/i
// An aspect ratio as `image()` takes it, `16/9`, or as the route does, `16x9`.
const ASPECT = /^(\d{1,3})[/x](\d{1,3})$/
const REMOTE = /^https?:\/\//i

// The share card social sites show, which they read best as a JPEG.
export const CARD = { width: 1200, height: 630 } as const
// The aspect ratios an image can be cut to unless `images.aspects` says otherwise: each one adds a variant per width, so the route makes only those asked for here.
export const DEFAULT_ASPECTS = ['1/1', '3/2', '2/3', '4/3', '3/4', '16/9', '9/16']
const LAST_WORD = /\S+$/

// The density an image is loaded at past which a phone shows no difference, as `images.maxDensity` sets it.
export const DEFAULT_MAX_DENSITY = 2
const DENSITY_META = 'meta[name="kay-max-density"]'
const WIDTHS_META = 'meta[name="kay-image-widths"]'

export const RESOLVED_META = 'kay-resolved-images'

// What `img` takes to load the right size: spread it, `img({...image(hero)} alt="")`.
export interface ImageProps {
  src: string
  srcset?: string | undefined
  sizes?: string | undefined
  width?: number | undefined
  height?: number | undefined
}

export interface ImageOptions {
  // How wide the image shows, as the `sizes` attribute reads it: `(min-width: 60rem) 50vw, 100vw`. Without it the browser assumes the viewport's width.
  sizes?: string | undefined
  // Its width and height for an image kay did not import, such as an upload: the variants stop at that width, and the page keeps its space while it loads.
  width?: number | undefined
  height?: number | undefined
  // The shape it is cut to, its middle kept: `'1/1'` for a square, `'16/9'`. Each variant is cut on the server, so a phone loads none of the pixels cut away; `images.aspects` lists the ones allowed.
  aspect?: string | undefined
  // The WebP and AVIF quality of this image's variants, 1 to 100, over `images.quality`: `90` for a photograph that shows banding at the default. Each quality an image is asked for adds a file per width, so it is set where the default does not do.
  quality?: number | undefined
}

// One file an image is turned into: a width of the ladder, cut to an aspect ratio or not, at a quality of its own or not, or the share card.
export type ImageVariant = { width: number, aspect?: Aspect, quality?: number } | 'card'

// An aspect ratio in lowest terms, `[16, 9]`.
export type Aspect = readonly [number, number]

// Imported images, by URL, with the size read when they were built.
const sizes = new Map<string, { width: number, height: number }>()
// The variant `src` falls back to for a browser that ignores `srcset`.
const FALLBACK_WIDTH = 1280
let maxDensity: number | undefined
// The widths `images.widths` sets, on the server; the browser reads them off the page.
let ladder: readonly number[] | undefined
// Refuses an aspect `images.aspects` does not list, set with it on the server; the browser checks none.
let aspectCheck: ((aspect: Aspect, text: string) => void) | undefined
// The variants of imported images that pages asked for beyond the ladder, by asset name, for `kay build` to write.
const requested = new Map<string, Map<string, ImageVariant>>()
// The variants of images on other hosts that a static export's pages link, by URL, for `kay build` to download and write.
const requestedRemote = new Map<string, Map<string, ImageVariant>>()
// Whether `images.remote` covers a URL, on the server; the browser checks none.
let remoteListed: ((src: string) => boolean) | undefined
// Whether it leaves out the host of an image on another host, which then keeps its own URL, set with it.
let unlistedCheck: ((src: string, caller: string) => boolean) | undefined
// Set on the server, which records the variants pages ask for and links the files a static export wrote: the browser asks the route.
let serverVariantUrl: typeof recordedVariantUrl | undefined
// Whether `images.resolve` looks sources up, which the browser reads off the page.
let resolved: boolean | undefined

// `images.maxDensity` on the server; the browser reads it off the page, where the server wrote it unless it is the default.
export function setMaxDensity(density: number): void {
  maxDensity = density
}

// The widths `images.widths` lists, sorted and without repeats; throws for anything but a list of whole numbers from 1 to 16384, at most 16 of them.
export function parseWidths(widths: unknown): number[] {
  if (!Array.isArray(widths) || widths.length === 0)
    throw new Error('images.widths is a list of widths in pixels, such as `[480, 960, 1920]`, with at least one')

  if (widths.length > MOST_WIDTHS)
    throw new Error(`images.widths lists ${widths.length} widths, at most ${MOST_WIDTHS}: each one adds a file per image`)

  for (const width of widths as unknown[]) {
    if (typeof width !== 'number' || !Number.isInteger(width) || width < 1 || width > WIDEST)
      throw new Error(`images.widths holds ${String(width)}: a width is a whole number of pixels from 1 to ${WIDEST}`)
  }

  return [...new Set(widths as number[])].sort((a, b) => a - b)
}

// `images.widths` on the server, the default ladder when none is given.
export function setImageWidths(widths: readonly number[] | undefined): void {
  ladder = widths === undefined ? undefined : parseWidths(widths)
}

// The widths the route makes, ascending: `images.widths`, which the browser reads off the page.
export function imageWidths(): readonly number[] {
  if (ladder === undefined && typeof document !== 'undefined') {
    const content = document.querySelector<HTMLMetaElement>(WIDTHS_META)?.content

    if (content !== undefined) {
      try {
        ladder = parseWidths(content.split(',').map(Number))
      }
      catch {
        ladder = undefined
      }
    }
  }

  return ladder ?? IMAGE_WIDTHS
}

export function setResolvedImages(on: boolean): void {
  resolved = on
}

// Hosts already warned about, once each per process.
const warnedHosts = new Set<string>()

export function setRemoteImages(listed: ((src: string) => boolean) | undefined): void {
  remoteListed = listed
  // Content from a CMS may hold any URL: a host left out is warned of once.
  unlistedCheck = listed && ((src, caller) => {
    if (!REMOTE.test(src) || listed(src))
      return false

    const host = hostOf(src)

    if (!warnedHosts.has(host)) {
      warnedHosts.add(host)
      kayLog('warn', `${caller} was given ${src}, on a host images.remote in kay.config.ts does not list, so it is not resized`)
    }

    return true
  })
}

// Not `URL.parse`, which Safari before 18 lacks, as this module ships to the browser too.
function hostOf(src: string): string {
  try {
    return new URL(src).host
  }
  catch {
    return src
  }
}

export function recordVariants(): void {
  serverVariantUrl = recordedVariantUrl
}

export function setAspects(allowed: readonly string[]): void {
  const aspects = new Set(allowed.map((text) => {
    const aspect = parseAspect(text)

    if (!aspect)
      throw new Error(`images.aspects holds ${text}: an aspect ratio is two whole numbers from 1 to 100, \`16/9\``)

    return aspectKey(aspect)
  }))

  aspectCheck = (aspect, text) => {
    if (!aspects.has(aspectKey(aspect)))
      throw new Error(`kay: image() was given aspect ${text}, which images.aspects in kay.config.ts does not list`)
  }
}

// `16/9` or `16x9` in lowest terms, or nothing when it is no ratio of whole numbers from 1 to 100.
export function parseAspect(text: string): Aspect | undefined {
  const match = ASPECT.exec(text)
  const [width, height] = [Number(match?.[1]), Number(match?.[2])]

  if (!match || width < 1 || width > 100 || height < 1 || height > 100)
    return undefined

  const divisor = gcd(width, height)

  return [width / divisor, height / divisor]
}

export function aspectKey([width, height]: Aspect): string {
  return `${width}x${height}`
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

// The largest box of that shape inside the image.
export function croppedSize(size: { width: number, height: number }, [width, height]: Aspect): { width: number, height: number } {
  const cut = Math.max(1, Math.min(size.width, Math.floor(size.height * width / height)))

  return { width: cut, height: variantHeight(cut, [width, height], size.height) }
}

// The height of a variant cut to a shape, at least 1 pixel and never past the image's own.
export function variantHeight(width: number, [aspectWidth, aspectHeight]: Aspect, most = Infinity): number {
  return Math.min(most, Math.max(1, Math.round(width * aspectHeight / aspectWidth)))
}

// A card, a crop, a quality of its own, or a width below `width`: the ladder's own widths aside, what a page asks for.
export function cutOrBelow(variant: ImageVariant, width: number): boolean {
  return variant === 'card' || variant.aspect !== undefined || variant.quality !== undefined || variant.width < width
}

// What a variant's file name ends with, after the image's own name.
export function variantSuffix(variant: ImageVariant): string {
  if (variant === 'card')
    return '-card.jpg'

  return `-${variant.width}${variant.aspect ? `-${aspectKey(variant.aspect)}` : ''}${variant.quality === undefined ? '' : `-q${variant.quality}`}.webp`
}

// The variants pages asked for of the imported image `name`, beyond its ladder.
export function requestedVariants(name: string): ImageVariant[] {
  return [...requested.get(name)?.values() ?? []]
}

// The variants of remote images a static export's pages link, each with the file name they link.
export function requestedRemoteVariants(): { src: string, name: string, variant: ImageVariant }[] {
  return [...requestedRemote].flatMap(([src, variants]) => [...variants.values()].map(variant => ({ src, name: remoteVariantName(src, variant), variant })))
}

// Named after a hash of the URL.
export function remoteVariantName(src: string, variant: ImageVariant): string {
  return `remote-${urlHash(src)}${variantSuffix(variant)}`
}

// cyrb53, 53 bits of a string's hash in base 36.
function urlHash(text: string): string {
  let h1 = 0xDEADBEEF
  let h2 = 0x41C6CE57

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)

    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

function currentMaxDensity(): number {
  if (maxDensity === undefined && typeof document !== 'undefined')
    maxDensity = Number(document.querySelector<HTMLMetaElement>(DENSITY_META)?.content ?? DEFAULT_MAX_DENSITY)

  return maxDensity ?? DEFAULT_MAX_DENSITY
}

// What the route resizes, a query after the name allowed.
export const RESIZABLE = /\.(?:png|jpe?g|webp|gif|avif)(?:\?.*)?$/i
// An SVG, which only a share card draws, rasterized to cover the card.
export const SVG_IMAGE = /\.svg(?:\?.*)?$/i

// A file the route resizes or, with `images.resolve` set, any path of the site, which the app looks up with no file extension to go by.
function resizable(src: string): boolean {
  resolved ??= typeof document !== 'undefined' && document.querySelector(`meta[name="${RESOLVED_META}"]`) !== null

  return RESIZABLE.test(src) || (resolved && src.startsWith('/') && !src.startsWith('//'))
}

// What an image module exports: its URL, its size recorded for `image()`.
export function registerImage(url: string, width: number, height: number): string {
  sizes.set(url, { width, height })

  return url
}

// The size `registerImage` recorded for an imported image's URL.
export function importedSize(url: string): { width: number, height: number } | undefined {
  return sizes.get(url)
}

// The size a stored image's URL holds.
export function storedSize(src: string): { width: number, height: number } | undefined {
  const match = src.startsWith(FILES_ROUTE) ? STORED_SIZE.exec(src) : null

  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined
}

// An imported or stored image, or one from a directory in `images.dirs` or a host in `images.remote` given its size, served as WebP variants at each width of the ladder up to its own; drawn at a fixed width, `sizes: '95px'`, at that width for each density up to `images.maxDensity`.
export function image(src: string, options: ImageOptions = {}): ImageProps {
  const own = sizes.get(src) ?? storedSize(src) ?? (options.width !== undefined && options.height !== undefined ? { width: options.width, height: options.height } : undefined)

  if (!own || !resizable(src) || unlistedCheck?.(src, 'image()') === true)
    return Object.assign(options.sizes === undefined ? { src } : { src, sizes: options.sizes }, own)

  const aspect = options.aspect === undefined ? undefined : allowedAspect(options.aspect)
  const size = aspect ? croppedSize(own, aspect) : own
  const fixed = FIXED_SIZE.exec(options.sizes ?? '')
  const quality = options.quality === undefined ? undefined : allowedQuality(options.quality)
  const widths = fixed ? fixedWidths(Number(fixed[1]), currentMaxDensity(), size.width) : [...imageWidths().filter(width => width < size.width), size.width]

  return {
    src: imageUrl(src, widths.findLast(width => width <= FALLBACK_WIDTH) ?? widths[0]!, aspect, quality),
    srcset: widths.map(width => `${imageUrl(src, width, aspect, quality)} ${width}w`).join(', '),
    sizes: cappedSizes(options.sizes ?? '100vw', currentMaxDensity()),
    width: size.width,
    height: size.height,
  }
}

// The widths an image drawn `drawn` pixels wide needs, from 1x to the densest screen it is loaded for, each the narrowest the route makes at or above it, none past the image's own.
function fixedWidths(drawn: number, density: number, most: number): number[] {
  const densest = Number.isFinite(density) ? density : UNCAPPED_DENSITY
  const densities = [...Array.from({ length: Math.floor(densest) }, (_, index) => index + 1), densest]

  return [...new Set(densities.map(at => Math.min(most, routeWidth(drawn * at))))].sort((a, b) => a - b)
}

// The narrowest width the route makes at or above `width`, past the ladder the image's own.
function routeWidth(width: number): number {
  const steps = imageWidths()

  return width < steps[0]! ? Math.max(1, Math.ceil(width / SMALL_STEP)) * SMALL_STEP : steps.find(step => step >= width) ?? Infinity
}

export function allowedQuality(quality: number): number {
  if (!Number.isInteger(quality) || quality < 1 || quality > 100)
    throw new Error(`kay: image() was given quality ${String(quality)}: a quality is a whole number from 1 to 100`)

  return quality
}

function allowedAspect(text: string): Aspect {
  const aspect = parseAspect(text)

  if (!aspect)
    throw new Error(`kay: image() was given aspect ${text}: an aspect ratio is two whole numbers from 1 to 100, \`16/9\``)

  aspectCheck?.(aspect, text)

  return aspect
}

// The URL of an imported image, or one from `images.dirs` or `images.remote`, cut to the 1200x630 share card social sites show, as a JPEG, for `og:image`: `meta(property="og:image" content={shareImage(hero)})` in a `head` block. Smaller images are enlarged to fill it.
export function shareImage(src: string): string {
  if (!RESIZABLE.test(src))
    throw new Error(`kay: shareImage() cannot cut ${src}: it takes a PNG, JPEG, WebP, GIF or AVIF`)

  return unlistedCheck?.(src, 'shareImage()') === true ? src : variantUrl(src, 'card')
}

// `sizes` with entries ahead of each for screens denser than `density`, showing the image narrower there so the browser picks the variant that density needs: a 3x phone loads a 100vw image as a 2x one would.
// The browser lays the image out from its `width` and `height`, so only the variant it picks changes. `auto` is left as it is.
export function cappedSizes(sizes: string, density: number): string {
  const entries = splitSizes(sizes)

  if (!Number.isFinite(density) || entries.some(entry => entry.toLowerCase().startsWith('auto')))
    return sizes

  const capped: string[] = []

  // Screens past the cap come in steps, the first entry a browser matches winning: 3x and over, then 2.5x for a cap of 2.
  for (const resolution of [density + 1, density + 0.5]) {
    for (const entry of entries) {
      const length = sizeLength(entry)
      const condition = entry.slice(0, -length.length).trim()
      const screen = `(min-resolution: ${resolution}dppx)`

      capped.push(`${condition === '' ? screen : `${screen} and (${condition})`} calc(${length} * ${density} / ${resolution})`)
    }
  }

  return [...capped, ...entries].join(', ')
}

// The length ending a `sizes` entry, after its media condition if any: a function such as `calc(...)` whole, else its last word.
function sizeLength(entry: string): string {
  if (!entry.endsWith(')'))
    return LAST_WORD.exec(entry)![0]

  let depth = 0
  let open = entry.length - 1

  for (; open > 0; open--) {
    if (entry[open] === ')')
      depth++
    else if (entry[open] === '(' && --depth === 0)
      break
  }

  return entry.slice(open - FUNCTION_NAME.exec(entry.slice(0, open))![0].length)
}

// The entries of a `sizes` list, split at the commas outside parentheses, as `min(50vw, 30rem)` holds one.
function splitSizes(sizes: string): string[] {
  const entries: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index < sizes.length; index++) {
    const char = sizes[index]

    if (char === '(') {
      depth++
    }
    else if (char === ')') {
      depth--
    }
    else if (char === ',' && depth === 0) {
      entries.push(sizes.slice(start, index))
      start = index + 1
    }
  }

  entries.push(sizes.slice(start))

  return entries.map(entry => entry.trim()).filter(entry => entry !== '')
}

// What `img(src={hero})` takes for an imported or stored image: its variants, its `sizes` capped, and its size unless the template gives one. Any other `src` goes as it is, `sizes` too.
export function imageSource(src: unknown, sized: boolean, sizesAttribute?: unknown): ImageProps | { src: unknown, sizes?: unknown } {
  if (typeof src !== 'string' || !(sizes.has(src) || storedSize(src)))
    return sizesAttribute == null ? { src } : { src, sizes: sizesAttribute }

  const props = image(src, sizesAttribute == null ? {} : { sizes: String(sizesAttribute) })

  if (sized) {
    delete props.width
    delete props.height
  }

  return props
}

// A static export has no image route, so an imported image's variants are linked as the files `kay build` wrote.
let variantFiles = false

export function linkVariantFiles(): void {
  variantFiles = true
}

export function variantFilesLinked(): boolean {
  return variantFiles
}

export interface ShareCardOptions {
  title: string
  // An imported image, an SVG included, or a raster one from `images.dirs` or `images.remote`, covering the card behind the title.
  image?: string | undefined
}

// Set by the server, which holds the face and the key a card is drawn and signed with.
let cardMaker: ((title: string, image: string | undefined) => string) | undefined

export function setCardMaker(maker: typeof cardMaker): void {
  cardMaker = maker
}

// The URL of a 1200x630 share card drawn for the page, its title over the image if one is given, for `og:image`: `meta(property="og:image" content={shareCard({ title: post.title, image: post.cover })})` in a `head` block.
export function shareCard(card: ShareCardOptions): string {
  if (card.image !== undefined && SVG_IMAGE.test(card.image) && !card.image.startsWith(IMPORTED))
    throw new Error(`kay: shareCard() cannot draw on ${card.image}: an SVG is taken only when imported, not from images.dirs, images.remote or a stored file`)

  if (card.image !== undefined && !RESIZABLE.test(card.image) && !SVG_IMAGE.test(card.image))
    throw new Error(`kay: shareCard() cannot draw on ${card.image}: it takes a PNG, JPEG, WebP, GIF, AVIF or an imported SVG`)

  if (card.image !== undefined && remoteListed && REMOTE.test(card.image) && !remoteListed(card.image))
    throw new Error(`kay: shareCard() was given ${card.image}, on a host images.remote in kay.config.ts does not list, so the card cannot be drawn on it`)

  if (!cardMaker)
    throw new Error('kay: shareCard() draws on the server, in a page\'s head')

  return cardMaker(card.title, card.image)
}

export function imageUrl(src: string, width: number, aspect?: Aspect, quality?: number): string {
  return variantUrl(src, { width, ...aspect && { aspect }, ...quality !== undefined && { quality } })
}

function variantUrl(src: string, variant: ImageVariant): string {
  const query = variant === 'card' ? 'card' : `w=${variant.width}${variant.aspect ? `&crop=${aspectKey(variant.aspect)}` : ''}${variant.quality === undefined ? '' : `&q=${variant.quality}`}`

  return serverVariantUrl?.(src, variant) ?? `${IMAGE_ROUTE}?src=${encodeURIComponent(src)}&${query}`
}

// The file of a variant a static export wrote, recording the variants pages ask for beyond the ladder; nothing where the route serves it.
function recordedVariantUrl(src: string, variant: ImageVariant): string | undefined {
  // A crop, a card or a width below the ladder, which only pages ask for.
  const asked = cutOrBelow(variant, imageWidths()[0]!)

  if (variantFiles && REMOTE.test(src)) {
    requestedRemote.set(src, (requestedRemote.get(src) ?? new Map<string, ImageVariant>()).set(variantSuffix(variant), variant))

    return `${VARIANTS}${remoteVariantName(src, variant)}`
  }

  if (src.startsWith(IMPORTED) && (asked || variantFiles)) {
    const name = decodeURIComponent(src.slice(IMPORTED.length).replace(QUERY, ''))

    // The ladder is written for every imported image, the rest only for those a page asks for.
    if (asked)
      requested.set(name, (requested.get(name) ?? new Map<string, ImageVariant>()).set(variantSuffix(variant), variant))

    if (variantFiles)
      return `${VARIANTS}${encodeURIComponent(`${name.replace(EXTENSION, '')}${variantSuffix(variant)}`)}`
  }

  return undefined
}
