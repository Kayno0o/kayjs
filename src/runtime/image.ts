// The widths an image is resized to, the only ones the image route makes: a fixed ladder keeps how many files one image can turn into bounded.
export const IMAGE_WIDTHS = [320, 640, 960, 1280, 1920, 2560, 3840] as const
export const IMAGE_ROUTE = '/_kay/image'
// Where imported images are served, and the variants `kay build` writes of them.
const IMPORTED = '/_kay/assets/'
const VARIANTS = '/_kay/images/'
const EXTENSION = /\.[^.]+$/
const QUERY = /\?.*$/

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
  const props: ImageProps = { src }

  if (options.sizes !== undefined)
    props.sizes = options.sizes

  if (!size || !RESIZABLE.test(src))
    return Object.assign(props, size)

  const widths = [...IMAGE_WIDTHS.filter(width => width < size.width), size.width]

  props.src = imageUrl(src, widths.findLast(width => width <= FALLBACK_WIDTH) ?? widths[0]!)
  props.srcset = widths.map(width => `${imageUrl(src, width)} ${width}w`).join(', ')
  props.width = size.width
  props.height = size.height

  return props
}

// What `img(src={hero})` takes for an imported image: its variants, and its size unless the template gives one. Any other `src` goes as it is.
export function imageSource(src: unknown, sized: boolean): ImageProps | { src: unknown } {
  if (typeof src !== 'string' || !sizes.has(src))
    return { src }

  const props = image(src)

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
