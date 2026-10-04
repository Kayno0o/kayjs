import type { Elysia } from 'elysia'
import type { ManifestConfig } from '../config'
import type { HeadTag } from '../runtime/head'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { revalidated } from './public'

export const FAVICON_DIR = 'favicon'
const MANIFEST = '/manifest.webmanifest'
// Browsers ask for the first two at these paths on their own; the manifest points at the others.
const PNG_FILES: Record<string, number> = { '/apple-touch-icon.png': 180, '/icon-192.png': 192, '/icon-512.png': 512 }
const ICO_SIZES = [16, 32, 48]
// The widest icon kay writes, which the source must reach so none is upscaled.
const LARGEST = 512
const ICO = '/favicon.ico'

// Every path the favicon serves.
export const FAVICON_PATHS = [ICO, ...Object.keys(PNG_FILES), MANIFEST]

export interface FaviconOptions {
  // The square source image, absolute.
  source: string
  // Where `kay build` wrote the files, read instead of the source when there.
  builtDir: string
  name?: string
  manifest?: ManifestConfig
  // The site's mount point, which the manifest's paths go under.
  base?: string
}

// The favicon in the sizes browsers ask for: an ICO of PNGs, the Apple touch icon and the manifest's icons.
export async function faviconFiles(source: string): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const { width, height } = await new Bun.Image(source).metadata()

  if (width !== height || width < LARGEST)
    throw new Error(`kay: the favicon ${source} is ${width}x${height}; it has to be square, ${LARGEST}x${LARGEST} or more`)

  const files = new Map<string, Uint8Array<ArrayBuffer>>()
  const png = async (size: number) => new Uint8Array(await new Bun.Image(source).resize(size, size).png().bytes())

  for (const [path, size] of Object.entries(PNG_FILES))
    files.set(path, await png(size))

  files.set(ICO, ico(await Promise.all(ICO_SIZES.map(png)), ICO_SIZES))

  return files
}

export async function writeFavicons(source: string, dir: string): Promise<void> {
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

// The links every page carries for them, which a page's own replace.
export function faviconTags(manifest?: ManifestConfig): HeadTag[] {
  const tags: HeadTag[] = [
    { tag: 'link', props: { rel: 'icon', href: ICO, sizes: ICO_SIZES.map(size => `${size}x${size}`).join(' ') } },
    { tag: 'link', props: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
    { tag: 'link', props: { rel: 'manifest', href: MANIFEST } },
  ]

  if (manifest?.themeColor !== undefined)
    tags.push({ tag: 'meta', props: { name: 'theme-color', content: manifest.themeColor } })

  return tags
}

// Its icons and start page under the site's mount point.
export function manifestJson(name: string | undefined, manifest: ManifestConfig = {}, base = ''): string {
  return JSON.stringify({
    name,
    short_name: manifest.shortName ?? name,
    icons: [192, 512].map(size => ({ src: `${base}/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png' })),
    start_url: `${base}/`,
    display: manifest.display,
    theme_color: manifest.themeColor,
    background_color: manifest.backgroundColor,
  })
}

// Serves the favicon files and the manifest at their paths, except one a public file or a page already serves; made from the source on first request unless `kay build` wrote them.
export function serveFavicons(app: Elysia, taken: Set<string>, options: FaviconOptions): void {
  let files: Promise<Map<string, Uint8Array<ArrayBuffer>>> | undefined
  const read = async () => {
    const built = new Map<string, Uint8Array<ArrayBuffer>>()

    for (const path of [...Object.keys(PNG_FILES), ICO]) {
      const file = Bun.file(join(options.builtDir, path.slice(1)))

      if (!await file.exists())
        return faviconFiles(options.source)

      built.set(path, await file.bytes())
    }

    return built
  }

  const respond = (request: Request, body: Uint8Array<ArrayBuffer> | string, type: string) => revalidated(request, `"${Bun.hash(body).toString(36)}"`, () => body, { 'content-type': type })

  for (const path of [...Object.keys(PNG_FILES), ICO]) {
    if (taken.has(path))
      continue

    app.get(path, async ({ request }) => {
      files ??= read()

      try {
        return respond(request, (await files).get(path)!, path === ICO ? 'image/x-icon' : 'image/png')
      }
      catch (error) {
        // The next request tries again, once the source is fixed.
        files = undefined

        throw error
      }
    })
  }

  if (!taken.has(MANIFEST)) {
    const manifest = manifestJson(options.name, options.manifest, options.base)

    app.get(MANIFEST, ({ request }) => respond(request, manifest, 'application/manifest+json'))
  }
}
