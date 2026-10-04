import type { Elysia } from 'elysia'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { ASSET_PREFIX } from '../build/assets'
import { IMAGE_ROUTE, IMAGE_WIDTHS } from '../runtime/image'
import { matchesEtag } from './public'
import { decodePath } from './routes'

export interface ImageRouteOptions {
  // The built client, where imported images and the variants `kay build` made live.
  clientDir: string
  // Where variants made on request are kept.
  cacheDir: string
  // Directories of images added at runtime, by the URL path they are served at, the directories absolute.
  dirs?: Record<string, string>
  quality?: number
}

export const VARIANTS_DIR = 'images'
const ASSETS_PATH = `${ASSET_PREFIX}assets/`
const RESIZABLE = /\.(?:png|jpe?g|webp)$/i
const IMMUTABLE = 'public, max-age=31536000, immutable'
const REVALIDATE = 'public, max-age=0, must-revalidate'
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
const LADDER = new Set<number>(IMAGE_WIDTHS)

// The file name of one variant of an image the build or the route wrote.
export function variantName(source: string, width: number): string {
  return `${basename(source, extname(source))}-${width}.webp`
}

export async function writeVariant(source: string, width: number, target: string, quality = 80): Promise<void> {
  await new Bun.Image(source).resize(width, undefined, { withoutEnlargement: true }).webp({ quality }).write(target)
}

// Every width of the ladder below an imported image's own, and its own, written next to the build for the route to serve as files.
export async function writeImageVariants(clientDir: string, quality?: number): Promise<number> {
  const assets = join(clientDir, 'assets')
  let written = 0

  if (!existsSync(assets))
    return written

  const names = await readdir(assets)

  await Promise.all(names.filter(name => RESIZABLE.test(name)).map(async (name) => {
    const source = join(assets, name)
    const { width } = await new Bun.Image(source).metadata()

    for (const variant of [...IMAGE_WIDTHS.filter(step => step < width), width]) {
      const target = join(clientDir, VARIANTS_DIR, variantName(name, variant))

      if (!await Bun.file(target).exists()) {
        await writeVariant(source, variant, target, quality)
        written++
      }
    }
  }))

  return written
}

// `/_kay/image?src=...&w=640` answers a WebP of an imported image, or of one in a directory of runtime images, at a width of the ladder or its own.
export function serveImages(app: Elysia, options: ImageRouteOptions): void {
  const pending = new Map<string, Promise<void>>()

  app.get(IMAGE_ROUTE, async ({ request }) => {
    const url = new URL(request.url)
    const src = url.searchParams.get('src') ?? ''
    const width = Number(url.searchParams.get('w'))
    const source = sourceFile(src, options)

    if (!source)
      return new Response('Not found', { status: 404, headers: TEXT })

    let stats: { size: number, mtimeMs: number }

    try {
      stats = await stat(source.path)
    }
    catch {
      return new Response('Not found', { status: 404, headers: TEXT })
    }

    let own: number

    try {
      own = (await new Bun.Image(source.path).metadata()).width
    }
    catch {
      return new Response('Not an image kay can resize', { status: 415, headers: TEXT })
    }

    if (!Number.isInteger(width) || (width !== own && !(LADDER.has(width) && width < own)))
      return new Response(`Width ${url.searchParams.get('w')} is neither one of ${IMAGE_WIDTHS.join(', ')} below the image's own nor its own, ${own}`, { status: 400, headers: TEXT })

    // An imported image is named after its content; a public one may change in place, so its size and time go in the name.
    const name = source.immutable ? variantName(source.path, width) : `${Bun.hash(`${source.path}\n${stats.size}\n${stats.mtimeMs}`).toString(36)}-${width}.webp`
    const built = join(options.clientDir, VARIANTS_DIR, name)
    const cached = join(options.cacheDir, name)
    let file = source.immutable && await Bun.file(built).exists() ? built : cached

    if (file === cached && !await Bun.file(cached).exists()) {
      let writing = pending.get(cached)

      // Requests for a variant being written wait for that one write.
      if (!writing) {
        writing = (async () => {
          try {
            await writeVariant(source.path, width, cached, options.quality)
          }
          finally {
            pending.delete(cached)
          }
        })()
        pending.set(cached, writing)
      }

      try {
        await writing
      }
      catch {
        return new Response('Not an image kay can resize', { status: 415, headers: TEXT })
      }

      file = cached
    }

    if (source.immutable)
      return new Response(Bun.file(file), { headers: { 'cache-control': IMMUTABLE } })

    const etag = `W/"${name}"`

    if (matchesEtag(request.headers.get('if-none-match'), etag))
      return new Response(null, { status: 304, headers: { etag, 'cache-control': REVALIDATE } })

    return new Response(Bun.file(file), { headers: { etag, 'cache-control': REVALIDATE } })
  })
}

// The file a `src` names, never one outside the built assets or the directories of runtime images.
function sourceFile(src: string, options: ImageRouteOptions): { path: string, immutable: boolean } | undefined {
  const decoded = decodePath(src)

  if (decoded === undefined || decoded.includes('\0') || !RESIZABLE.test(decoded))
    return undefined

  if (src.startsWith(ASSETS_PATH)) {
    const dir = join(options.clientDir, 'assets')
    const path = normalize(resolve(dir, decodePath(src.slice(ASSETS_PATH.length)) ?? ''))

    return path.startsWith(dir + sep) ? { path, immutable: true } : undefined
  }

  for (const [prefix, dir] of Object.entries(options.dirs ?? {})) {
    const base = prefix.endsWith('/') ? prefix : `${prefix}/`

    if (!decoded.startsWith(base))
      continue

    const path = normalize(resolve(dir, decoded.slice(base.length)))

    if (path.startsWith(dir + sep))
      return { path, immutable: false }
  }

  return undefined
}
