import type { Elysia } from 'elysia'
import { existsSync } from 'node:fs'
import { readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { ASSET_PREFIX } from '../build/assets'
import { DEFAULT_MAX_DENSITY, IMAGE_ROUTE, IMAGE_WIDTHS, RESIZABLE, setMaxDensity } from '../runtime/image'
import { revalidated } from './public'
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
const IMMUTABLE = 'public, max-age=31536000, immutable'
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
const LADDER = new Set<number>(IMAGE_WIDTHS)
// About 50 megapixels: a runtime image larger than that, which could take gigabytes to decode, is refused before any pixel is read.
const MAX_UPLOAD_PIXELS = 50_000_000
const DEFAULT_QUALITY = 80

// The file name of one variant of an image the build or the route wrote.
export function variantName(source: string, width: number): string {
  return `${basename(source, extname(source))}-${width}.webp`
}

// Written under a temporary name and moved into place, so a reader never sees a variant half written, nor one a crash cut short.
export async function writeVariant(source: string, width: number, target: string, quality = DEFAULT_QUALITY): Promise<void> {
  const partial = `${target}.${crypto.randomUUID()}.tmp`

  // Read through Bun.file, which also reaches the files an executable embeds, where Bun.Image given a path does not.
  await new Bun.Image(Bun.file(source)).resize(width, undefined, { withoutEnlargement: true }).webp({ quality }).write(partial)
  await rename(partial, target)
}

// Every width of the ladder below an imported image's own, and its own, written next to the build for the route to serve as files; returns how many were encoded.
// With a cache directory, a variant an earlier build encoded is copied from it, and what this build no longer uses is pruned from it, unless `prune` is off for a pass that sees only some of the build's images.
export async function writeImageVariants(clientDir: string, quality = DEFAULT_QUALITY, cacheDir?: string, { prune = true } = {}): Promise<number> {
  const assets = join(clientDir, 'assets')
  const used = new Set<string>()
  let encoded = 0

  if (!existsSync(assets))
    return encoded

  const names = await readdir(assets)

  await Promise.all(names.filter(name => RESIZABLE.test(name)).map(async (name) => {
    const source = join(assets, name)
    const { width } = await new Bun.Image(source).metadata()

    for (const variant of [...IMAGE_WIDTHS.filter(step => step < width), width]) {
      const target = join(clientDir, VARIANTS_DIR, variantName(name, variant))
      // Asset names carry a hash of their content, so a cached variant only goes stale when the quality changes.
      const cachedName = `${quality}-${variantName(name, variant)}`
      const cached = cacheDir && join(cacheDir, cachedName)

      used.add(cachedName)

      if (await Bun.file(target).exists())
        continue

      if (!cached || !await Bun.file(cached).exists()) {
        await writeVariant(source, variant, cached || target, quality)
        encoded++
      }

      if (cached)
        await Bun.write(target, Bun.file(cached))
    }
  }))

  if (prune && cacheDir && existsSync(cacheDir))
    await Promise.all((await readdir(cacheDir)).filter(name => !used.has(name)).map(async name => rm(join(cacheDir, name), { force: true })))

  return encoded
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
      own = (await new Bun.Image(Bun.file(source.path), { maxPixels: source.immutable ? undefined : MAX_UPLOAD_PIXELS }).metadata()).width
    }
    catch (error) {
      if ((error as { code?: string }).code === 'ERR_IMAGE_TOO_MANY_PIXELS')
        return new Response(`Image over ${MAX_UPLOAD_PIXELS} pixels`, { status: 413, headers: TEXT })

      return new Response('Not an image kay can resize', { status: 415, headers: TEXT })
    }

    if (!Number.isInteger(width) || (width !== own && !(LADDER.has(width) && width < own)))
      return new Response(`Width ${url.searchParams.get('w')} is neither one of ${IMAGE_WIDTHS.join(', ')} below the image's own nor its own, ${own}`, { status: 400, headers: TEXT })

    // An imported image is named after its content; a runtime one may change in place, so its size and time go in the name.
    const name = source.immutable ? variantName(source.path, width) : `${Bun.hash(`${source.path}\n${stats.size}\n${stats.mtimeMs}`).toString(36)}-${width}.webp`
    const built = join(options.clientDir, VARIANTS_DIR, name)
    const cached = join(options.cacheDir, name)
    let file = source.immutable && await Bun.file(built).exists() ? built : cached

    let writing = pending.get(cached)

    // Requests for a variant being written wait for that one write.
    if (file === cached && (writing || !await Bun.file(cached).exists())) {
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

    return revalidated(request, `W/"${name}"`, () => Bun.file(file))
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

// `images.maxDensity`, checked and set for every image this process renders, served or prerendered.
export function applyMaxDensity(images: { maxDensity?: number } | undefined): number {
  const maxDensity = images?.maxDensity ?? DEFAULT_MAX_DENSITY

  if (!(maxDensity >= 1))
    throw new Error(`images.maxDensity is ${maxDensity}: it is at least 1, or Infinity to leave the browser's choice`)

  setMaxDensity(maxDensity)

  return maxDensity
}
