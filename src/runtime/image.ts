// The widths an image is resized to, the only ones the image route makes: a fixed ladder keeps how many files one image can turn into bounded.
export const IMAGE_WIDTHS = [320, 640, 960, 1280, 1920, 2560, 3840] as const
export const IMAGE_ROUTE = '/_kay/image'
// Where imported images are served, and the variants `kay build` writes of them.
const IMPORTED = '/_kay/assets/'
const VARIANTS = '/_kay/images/'
const EXTENSION = /\.[^.]+$/
const QUERY = /\?.*$/
const FUNCTION_NAME = /[a-z-]*$/i
// An aspect ratio as `image()` takes it, `16/9`, or as the route does, `16x9`.
const ASPECT = /^(\d{1,3})[/x](\d{1,3})$/

// The share card social sites show, which they read best as a JPEG.
export const CARD = { width: 1200, height: 630 } as const
// The aspect ratios an image can be cut to unless `images.aspects` says otherwise: each one adds a variant per width, so the route makes only those asked for here.
export const DEFAULT_ASPECTS = ['1/1', '3/2', '2/3', '4/3', '3/4', '16/9', '9/16']
const LAST_WORD = /\S+$/

// The density an image is loaded at past which a phone shows no difference, as `images.maxDensity` sets it.
export const DEFAULT_MAX_DENSITY = 2
const DENSITY_META = 'meta[name="kay-max-density"]'

// What `img` takes to load the right size: spread it, `img({...image(hero)} alt="")`.
export interface ImageProps {
  src: string
  srcset?: string
  sizes?: string
  width?: number
  height?: number
}

export interface ImageOptions {
  // How wide the image shows, as the `sizes` attribute reads it: `(min-width: 60rem) 50vw, 100vw`. Without it the browser assumes the viewport's width.
  sizes?: string
  // Its width and height for an image kay did not import, such as an upload: the variants stop at that width, and the page keeps its space while it loads.
  width?: number
  height?: number
  // The shape it is cut to, its middle kept: `'1/1'` for a square, `'16/9'`. Each variant is cut on the server, so a phone loads none of the pixels cut away; `images.aspects` lists the ones allowed.
  aspect?: string
}

// One file an image is turned into: a width of the ladder, cut to an aspect ratio or not, or the share card.
export type ImageVariant = { width: number, aspect?: Aspect } | 'card'

// An aspect ratio in lowest terms, `[16, 9]`.
export type Aspect = readonly [number, number]

// Imported images, by URL, with the size read when they were built.
const sizes = new Map<string, { width: number, height: number }>()
// The variant `src` falls back to for a browser that ignores `srcset`.
const FALLBACK_WIDTH = 1280
let maxDensity: number | undefined
// `images.aspects` on the server, in lowest terms as `16x9`; the browser checks none.
let aspects: ReadonlySet<string> | undefined
// The variants of imported images that pages asked for beyond the ladder, by asset name, for `kay build` to write.
const requested = new Map<string, Map<string, ImageVariant>>()

// `images.maxDensity` on the server; the browser reads it off the page, where the server wrote it unless it is the default.
export function setMaxDensity(density: number): void {
  maxDensity = density
}

export function setAspects(allowed: readonly string[]): void {
  aspects = new Set(allowed.map((text) => {
    const aspect = parseAspect(text)

    if (!aspect)
      throw new Error(`images.aspects holds ${text}: an aspect ratio is two whole numbers from 1 to 100, \`16/9\``)

    return aspectKey(aspect)
  }))
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

// What a variant's file name ends with, after the image's own name.
export function variantSuffix(variant: ImageVariant): string {
  if (variant === 'card')
    return '-card.jpg'

  return `-${variant.width}${variant.aspect ? `-${aspectKey(variant.aspect)}` : ''}.webp`
}

// The variants pages asked for of the imported image `name`, beyond its ladder.
export function requestedVariants(name: string): ImageVariant[] {
  return [...requested.get(name)?.values() ?? []]
}

function currentMaxDensity(): number {
  if (maxDensity === undefined && typeof document !== 'undefined')
    maxDensity = Number(document.querySelector<HTMLMetaElement>(DENSITY_META)?.content ?? DEFAULT_MAX_DENSITY)

  return maxDensity ?? DEFAULT_MAX_DENSITY
}

// What Bun.Image reads and the route resizes, a query after the name allowed.
export const RESIZABLE = /\.(?:png|jpe?g|webp)(?:\?.*)?$/i

// What an image module exports: its URL, its size recorded for `image()`.
export function registerImage(url: string, width: number, height: number): string {
  sizes.set(url, { width, height })

  return url
}

// An imported image, or one from a directory in `images.dirs` given its size, served as WebP variants at each width of the ladder up to its own.
export function image(src: string, options: ImageOptions = {}): ImageProps {
  const own = sizes.get(src) ?? (options.width !== undefined && options.height !== undefined ? { width: options.width, height: options.height } : undefined)

  if (!own || !RESIZABLE.test(src))
    return Object.assign(options.sizes === undefined ? { src } : { src, sizes: options.sizes }, own)

  const aspect = options.aspect === undefined ? undefined : allowedAspect(options.aspect)
  const size = aspect ? croppedSize(own, aspect) : own
  const widths = [...IMAGE_WIDTHS.filter(width => width < size.width), size.width]

  return {
    src: imageUrl(src, widths.findLast(width => width <= FALLBACK_WIDTH) ?? widths[0]!, aspect),
    srcset: widths.map(width => `${imageUrl(src, width, aspect)} ${width}w`).join(', '),
    sizes: cappedSizes(options.sizes ?? '100vw', currentMaxDensity()),
    width: size.width,
    height: size.height,
  }
}

function allowedAspect(text: string): Aspect {
  const aspect = parseAspect(text)

  if (!aspect)
    throw new Error(`kay: image() was given aspect ${text}: an aspect ratio is two whole numbers from 1 to 100, \`16/9\``)

  if (aspects && !aspects.has(aspectKey(aspect)))
    throw new Error(`kay: image() was given aspect ${text}, which images.aspects in kay.config.ts does not list`)

  return aspect
}

// The URL of an image cut to the 1200x630 share card social sites show, as a JPEG, for `og:image`: `export const seo = { image: shareImage(hero) }`. Smaller images are enlarged to fill it.
export function shareImage(src: string): string {
  if (!RESIZABLE.test(src))
    throw new Error(`kay: shareImage() cannot cut ${src}: it takes a PNG, JPEG or WebP`)

  return variantUrl(src, 'card')
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

// What `img(src={hero})` takes for an imported image: its variants, its `sizes` capped, and its size unless the template gives one. Any other `src` goes as it is, `sizes` too.
export function imageSource(src: unknown, sized: boolean, sizesAttribute?: unknown): ImageProps | { src: unknown, sizes?: unknown } {
  if (typeof src !== 'string' || !sizes.has(src))
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

export function imageUrl(src: string, width: number, aspect?: Aspect): string {
  return variantUrl(src, aspect ? { width, aspect } : { width })
}

function variantUrl(src: string, variant: ImageVariant): string {
  if (src.startsWith(IMPORTED)) {
    const name = decodeURIComponent(src.slice(IMPORTED.length).replace(QUERY, ''))

    // The ladder is written for every imported image; a crop or a card only for those a page asks for.
    if (variant === 'card' || variant.aspect)
      requested.set(name, (requested.get(name) ?? new Map()).set(variantSuffix(variant), variant))

    if (variantFiles)
      return `${VARIANTS}${encodeURIComponent(`${name.replace(EXTENSION, '')}${variantSuffix(variant)}`)}`
  }

  const query = variant === 'card' ? 'card' : `w=${variant.width}${variant.aspect ? `&crop=${aspectKey(variant.aspect)}` : ''}`

  return `${IMAGE_ROUTE}?src=${encodeURIComponent(src)}&${query}`
}
