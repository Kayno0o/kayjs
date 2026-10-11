import type { Elysia } from 'elysia'
import type { FaviconConfig, ManifestConfig } from '../config'
import type { HeadTag } from '../runtime/head'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { kayLog } from '../runtime/log'
import { revalidated } from './public'

export const FAVICON_DIR = 'favicon'
// kay's own mark, served when a project names no favicon: the PNG the icons are made from, and the SVG browsers draw at any size.
const DEFAULT_FAVICON = join(import.meta.dir, 'favicon.png')
const DEFAULT_SVG = join(import.meta.dir, 'favicon.svg')
const SVG = '/favicon.svg'
const MANIFEST = '/manifest.webmanifest'
// Browsers ask for the first two at these paths on their own; the manifest points at the others.
const PNG_FILES: Record<string, number> = { '/apple-touch-icon.png': 180, '/icon-192.png': 192, '/icon-512.png': 512 }
const MASKABLE_FILES: Record<string, number> = { '/icon-maskable-192.png': 192, '/icon-maskable-512.png': 512 }
const MANIFEST_SIZES = [192, 512]
const ICO_SIZES = [16, 32, 48]
// The widest icon kay writes, which the source must reach so none is upscaled.
const LARGEST = 512
const ICO = '/favicon.ico'

// Every path the favicon serves, an SVG one adding its SVG and a maskable manifest icon its own icons.
export const FAVICON_PATHS = [ICO, ...Object.keys(PNG_FILES), MANIFEST, SVG, ...Object.keys(MASKABLE_FILES)]

// The image the icons are made from, the SVG served beside it and the manifest's maskable image, all absolute.
export interface FaviconSource {
  image: string
  svg?: string | undefined
  maskable?: string | undefined
}

// Whether a `favicon` setting serves an SVG: kay's mark does, and a project's own when it names one.
function servesSvg(favicon: string | FaviconConfig | undefined): boolean {
  return typeof favicon !== 'string'
}

// The paths a project's `favicon` and `manifest` settings serve.
export function faviconPaths(favicon: string | FaviconConfig | false | undefined, manifest?: ManifestConfig): string[] {
  if (favicon === false)
    return []

  return FAVICON_PATHS.filter(path => (path !== SVG || servesSvg(favicon)) && (!(path in MASKABLE_FILES) || manifest?.maskable !== undefined))
}

// The favicon's source: the project's own, kay's mark when it names none, or none once turned off.
export function faviconSource(root: string, favicon: string | FaviconConfig | false | undefined, manifest?: ManifestConfig): FaviconSource | undefined {
  if (favicon === false)
    return undefined

  const maskable = manifest?.maskable === undefined ? {} : { maskable: resolve(root, manifest.maskable) }

  if (favicon === undefined)
    return { image: DEFAULT_FAVICON, svg: DEFAULT_SVG, ...maskable }

  return typeof favicon === 'string' ? { image: resolve(root, favicon), ...maskable } : { image: resolve(root, favicon.image), svg: resolve(root, favicon.svg), ...maskable }
}

export interface FaviconOptions {
  source: FaviconSource
  // Where `kay build` wrote the files, read instead of the source when there.
  builtDir: string
  name?: string | undefined
  description?: string | undefined
  manifest?: ManifestConfig | undefined
  // The site's mount point, which the manifest's paths go under.
  base?: string | undefined
}

// The favicon in the sizes browsers ask for: an ICO of PNGs, the Apple touch icon and the manifest's icons, maskable ones included.
export async function faviconFiles({ image: source, svg, maskable }: FaviconSource): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  await checkSquare(source, 'favicon')

  if (maskable !== undefined)
    await checkSquare(maskable, 'maskable icon')

  const files = new Map<string, Uint8Array<ArrayBuffer>>()
  const png = async (image: string, size: number) => new Uint8Array(await new Bun.Image(image).resize(size, size).png().bytes())

  for (const [path, size] of Object.entries(PNG_FILES))
    files.set(path, await png(source, size))

  files.set(ICO, ico(await Promise.all(ICO_SIZES.map(async size => png(source, size))), ICO_SIZES))

  if (svg !== undefined)
    files.set(SVG, await Bun.file(svg).bytes())

  for (const [path, size] of maskable === undefined ? [] : Object.entries(MASKABLE_FILES))
    files.set(path, await png(maskable!, size))

  return files
}

async function checkSquare(source: string, what: string): Promise<void> {
  const { width, height } = await new Bun.Image(source).metadata()

  if (width !== height)
    throw new Error(`kay: the ${what} ${source} is ${width}x${height}; it has to be square`)

  // Enlarged to the sizes it lacks, so the manifest keeps the 192 and 512 icons a browser asks for before it offers to install the site.
  if (width < LARGEST)
    kayLog('warn', `the ${what} ${source} is ${width}x${height}, enlarged to the icons up to ${LARGEST}x${LARGEST}, which look blurred; a source of ${LARGEST}x${LARGEST} or more keeps them sharp`)
}

export async function writeFavicons(source: FaviconSource, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })

  for (const [path, bytes] of await faviconFiles(source))
    await Bun.write(join(dir, path.slice(1)), bytes)
}

// An ICO holding PNG images, which every browser reads: a 6-byte header, a 16-byte entry per image, then the images.
function ico(images: Uint8Array[], sizes: number[]): Uint8Array<ArrayBuffer> {
  const header = 6 + 16 * images.length
  const bytes = new Uint8Array(header + images.reduce((total, image) => total + image.length, 0))
  const view = new DataView(bytes.buffer)
  let offset = header

  view.setUint16(2, 1, true)
  view.setUint16(4, images.length, true)

  for (const [index, image] of images.entries()) {
    const entry = 6 + 16 * index

    view.setUint8(entry, sizes[index]! % 256)
    view.setUint8(entry + 1, sizes[index]! % 256)
    view.setUint16(entry + 4, 1, true)
    view.setUint16(entry + 6, 32, true)
    view.setUint32(entry + 8, image.length, true)
    view.setUint32(entry + 12, offset, true)
    bytes.set(image, offset)
    offset += image.length
  }

  return bytes
}

// The links every page carries for them, which a page's own replace; an SVG is linked after the ICO, which browsers drawing SVG icons then prefer.
export function faviconTags(favicon: string | FaviconConfig | undefined): HeadTag[] {
  return [
    { tag: 'link', props: { rel: 'icon', href: ICO, sizes: ICO_SIZES.map(size => `${size}x${size}`).join(' ') } },
    ...servesSvg(favicon) ? [{ tag: 'link', props: { rel: 'icon', href: SVG, type: 'image/svg+xml' } } satisfies HeadTag] : [],
    { tag: 'link', props: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
    { tag: 'link', props: { rel: 'manifest', href: MANIFEST } },
  ]
}

// Its icons, pages and scope under the site's mount point.
export function manifestJson(name: string | undefined, description: string | undefined, manifest: ManifestConfig = {}, base = ''): string {
  const icon = (kind: string, purpose?: string) => (size: number) => ({ src: `${base}/${kind}-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose })

  return JSON.stringify({
    name,
    short_name: manifest.shortName ?? name,
    description,
    icons: [...MANIFEST_SIZES.map(icon('icon')), ...manifest.maskable === undefined ? [] : MANIFEST_SIZES.map(icon('icon-maskable', 'maskable'))],
    start_url: base + sitePath(manifest.startUrl ?? '/', 'startUrl'),
    scope: manifest.scope === undefined ? undefined : base + sitePath(manifest.scope, 'scope'),
    display: manifest.display,
    orientation: manifest.orientation,
    theme_color: manifest.themeColor,
    background_color: manifest.backgroundColor,
    shortcuts: manifest.shortcuts?.map(shortcut => ({ name: shortcut.name, short_name: shortcut.shortName, description: shortcut.description, url: base + sitePath(shortcut.url, `a shortcut's url`) })),
  })
}

function sitePath(path: string, what: string): string {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new Error(`kay: the manifest's ${what} is a path of the site, starting with a single /, not ${path}`)

  return path
}

// Serves the favicon files and the manifest at their paths, except one a public file or a page already serves; made from the source on first request unless `kay build` wrote them.
export function serveFavicons(app: Elysia, taken: Set<string>, options: FaviconOptions): void {
  let files: Promise<Map<string, Uint8Array<ArrayBuffer>>> | undefined
  const paths = [...Object.keys(PNG_FILES), ICO, ...options.source.svg === undefined ? [] : [SVG], ...options.source.maskable === undefined ? [] : Object.keys(MASKABLE_FILES)]
  const read = async () => {
    const built = new Map<string, Uint8Array<ArrayBuffer>>()

    for (const path of paths) {
      const file = Bun.file(join(options.builtDir, path.slice(1)))

      if (!await file.exists())
        return faviconFiles(options.source)

      built.set(path, await file.bytes())
    }

    return built
  }

  const respond = (request: Request, body: Uint8Array<ArrayBuffer> | string, type: string) => revalidated(request, `"${Bun.hash(body).toString(36)}"`, () => body, { 'content-type': type })

  for (const path of paths) {
    if (taken.has(path))
      continue

    app.get(path, async ({ request }) => {
      files ??= read()

      try {
        return respond(request, (await files).get(path)!, path === ICO ? 'image/x-icon' : path === SVG ? 'image/svg+xml' : 'image/png')
      }
      catch (error) {
        // The next request tries again, once the source is fixed.
        files = undefined

        throw error
      }
    })
  }

  if (!taken.has(MANIFEST)) {
    const manifest = manifestJson(options.name, options.description, options.manifest, options.base)

    app.get(MANIFEST, ({ request }) => respond(request, manifest, 'application/manifest+json'))
  }
}
