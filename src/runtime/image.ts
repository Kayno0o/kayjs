// The widths an image is resized to, the only ones the image route makes: a fixed ladder keeps how many files one image can turn into bounded.
export const IMAGE_WIDTHS = [320, 640, 960, 1280, 1920, 2560, 3840] as const
export const IMAGE_ROUTE = '/_kay/image'
// Where imported images are served, and the variants `kay build` writes of them.
const IMPORTED = '/_kay/assets/'
const VARIANTS = '/_kay/images/'
const EXTENSION = /\.[^.]+$/
const QUERY = /\?.*$/
const FUNCTION_NAME = /[a-z-]*$/i
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
}

// Imported images, by URL, with the size read when they were built.
const sizes = new Map<string, { width: number, height: number }>()
// The variant `src` falls back to for a browser that ignores `srcset`.
const FALLBACK_WIDTH = 1280
let maxDensity: number | undefined

// `images.maxDensity` on the server; the browser reads it off the page, where the server wrote it unless it is the default.
export function setMaxDensity(density: number): void {
  maxDensity = density
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
  const size = sizes.get(src) ?? (options.width !== undefined && options.height !== undefined ? { width: options.width, height: options.height } : undefined)

  if (!size || !RESIZABLE.test(src))
    return Object.assign(options.sizes === undefined ? { src } : { src, sizes: options.sizes }, size)

  const widths = [...IMAGE_WIDTHS.filter(width => width < size.width), size.width]

  return {
    src: imageUrl(src, widths.findLast(width => width <= FALLBACK_WIDTH) ?? widths[0]!),
    srcset: widths.map(width => `${imageUrl(src, width)} ${width}w`).join(', '),
    sizes: cappedSizes(options.sizes ?? '100vw', currentMaxDensity()),
    width: size.width,
    height: size.height,
  }
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

export function imageUrl(src: string, width: number): string {
  if (variantFiles && src.startsWith(IMPORTED)) {
    const name = decodeURIComponent(src.slice(IMPORTED.length).replace(QUERY, ''))

    return `${VARIANTS}${encodeURIComponent(`${name.replace(EXTENSION, '')}-${width}.webp`)}`
  }

  return `${IMAGE_ROUTE}?src=${encodeURIComponent(src)}&w=${width}`
}
