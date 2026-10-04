// The widths an image is resized to, the only ones the image route makes: a fixed ladder keeps how many files one image can turn into bounded.
export const IMAGE_WIDTHS = [320, 640, 960, 1280, 1920, 2560, 3840] as const
export const IMAGE_ROUTE = '/_kay/image'

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

export function imageUrl(src: string, width: number): string {
  return `${IMAGE_ROUTE}?src=${encodeURIComponent(src)}&w=${width}`
}
