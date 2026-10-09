import type { Elysia } from 'elysia'
import type { Aspect, ImageVariant } from '../runtime/image'
import type { RemoteImages } from './remote'
import { existsSync } from 'node:fs'
import { readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { ASSET_PREFIX } from '../build/assets'
import { aspectKey, CARD, croppedSize, DEFAULT_ASPECTS, DEFAULT_MAX_DENSITY, IMAGE_ROUTE, IMAGE_WIDTHS, parseAspect, requestedRemoteVariants, requestedVariants, RESIZABLE, setAspects, setMaxDensity, setRemoteImages, variantHeight, variantSuffix } from '../runtime/image'
import { DEFAULT_AVIF_QUALITY, encodeAvif } from './avif'
import { coverImage } from './crop'
import { clientAddress } from './protection'
import { revalidated } from './public'
import { remoteAllowed, remotePatterns } from './remote'
import { decodePath } from './routes'

export interface ImageRouteOptions {
  // The built client, where imported images and the variants `kay build` made live.
  clientDir: string
  // Where variants made on request are kept.
  cacheDir: string
  // Directories of images added at runtime, by the URL path they are served at, the directories absolute.
  dirs?: Record<string, string>
  quality?: number
  // AVIF quality, which a request whose `Accept` names `image/avif` gets instead of WebP; none serves WebP alone.
  avif?: number
  // The aspect ratios variants are cut to, `images.aspects`.
  aspects?: readonly string[]
  // Downloads an image from a host `images.remote` lists.
  remote?: RemoteImages
}

export const VARIANTS_DIR = 'images'
const ASSETS_PATH = `${ASSET_PREFIX}assets/`
const IMMUTABLE = 'public, max-age=31536000, immutable'
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
const LADDER = new Set<number>(IMAGE_WIDTHS)
const REMOTE_URL = /^https?:\/\//i
const WEBP_EXTENSION = /\.webp$/

// About 50 megapixels: a runtime image larger than that, which could take gigabytes to decode, is refused before any pixel is read.
export const MAX_UPLOAD_PIXELS = 50_000_000
export const DEFAULT_QUALITY = 80

export type VariantFormat = 'webp' | 'avif'

// The file name of one variant of an image the build or the route wrote, a width of the ladder by default.
export function variantName(source: string, variant: number | ImageVariant, format: VariantFormat = 'webp'): string {
  return inFormat(`${basename(source, extname(source))}${variantSuffix(typeof variant === 'number' ? { width: variant } : variant)}`, format)
}

// `images.avif` as a quality, or undefined when it is off.
export function avifQuality(images: { avif?: false | { quality?: number } } | undefined): number | undefined {
  return images?.avif === false ? undefined : images?.avif?.quality ?? DEFAULT_AVIF_QUALITY
}

function inFormat(name: string, format: VariantFormat): string {
  return format === 'avif' ? name.replace(WEBP_EXTENSION, '.avif') : name
}

function acceptsAvif(accept: string | null): boolean {
  return accept?.split(',').some((entry) => {
    const [type = '', ...params] = entry.split(';')
    const weight = params.map(param => param.trim()).find(param => param.startsWith('q='))

    return type.trim().toLowerCase() === 'image/avif' && (weight === undefined || Number(weight.slice(2)) > 0)
  }) ?? false
}

// Written under a temporary name and moved into place, so a reader never sees a variant half written, nor one a crash cut short.
export async function writeVariant(source: string, variant: number | ImageVariant, target: string, quality = DEFAULT_QUALITY, format: VariantFormat = 'webp'): Promise<void> {
  const partial = `${target}.${crypto.randomUUID()}.tmp`

  // Read through Bun.file, which also reaches the files an executable embeds, where Bun.Image given a path does not.
  const file = Bun.file(source)
  const shape = typeof variant === 'number' ? { width: variant } : variant

  if (shape === 'card') {
    await new Bun.Image(await coverImage(file, CARD.width, CARD.height)).jpeg({ quality }).write(partial)
  }
  else {
    const image = shape.aspect ? new Bun.Image(await coverImage(file, shape.width, variantHeight(shape.width, shape.aspect))) : new Bun.Image(file).resize(shape.width, undefined, { withoutEnlargement: true })

    await (format === 'avif' ? Bun.write(partial, await encodeAvif(image, quality)) : image.webp({ quality }).write(partial))
  }

  await rename(partial, target)
}

// Every width of the ladder below an imported image's own, and its own, written next to the build for the route to serve as files, with the crops and share cards pages asked for, each in AVIF too given its quality; returns how many were encoded.
// With a cache directory, a variant an earlier build encoded is copied from it, and what this build no longer uses is pruned from it, unless `prune` is off for a pass that sees only some of the build's images.
export async function writeImageVariants(clientDir: string, quality = DEFAULT_QUALITY, cacheDir?: string, { prune = true, avif }: { prune?: boolean, avif?: number } = {}): Promise<number> {
  const assets = join(clientDir, 'assets')
  const used = new Set<string>()
  let encoded = 0

  if (!existsSync(assets))
    return encoded

  const names = await readdir(assets)

  await Promise.all(names.filter(name => RESIZABLE.test(name)).map(async (name) => {
    const source = join(assets, name)
    const { width } = await new Bun.Image(source).metadata()

    const variants = [...IMAGE_WIDTHS.filter(step => step < width), width, ...requestedVariants(name)]
    // The share card stays a JPEG, which social sites read best.
    const encodings = variants.flatMap(variant => [{ variant, format: 'webp' as const, level: quality }, ...avif === undefined || variant === 'card' ? [] : [{ variant, format: 'avif' as const, level: avif }]])

    for (const { variant, format, level } of encodings) {
      const target = join(clientDir, VARIANTS_DIR, variantName(name, variant, format))
      // Asset names carry a hash of their content, so a cached variant only goes stale when the quality changes.
      const cachedName = `${level}-${variantName(name, variant, format)}`
      const cached = cacheDir && join(cacheDir, cachedName)

      used.add(cachedName)

      if (await Bun.file(target).exists())
        continue

      if (!cached || !await Bun.file(cached).exists()) {
        await writeVariant(source, variant, cached || target, level, format)
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

// `/_kay/image?src=...&w=640` answers a WebP, or an AVIF to a browser that reads it when `avif` is set, of an imported image, or of one in a directory of runtime images or on a host `images.remote` lists, at a width of the ladder or its own; `&crop=16x9` cuts it to an aspect ratio `images.aspects` allows, and `?src=...&card` answers its 1200x630 JPEG share card.
export function serveImages(app: Elysia, options: ImageRouteOptions): void {
  const pending = new Map<string, Promise<void>>()
  const allowed = new Set((options.aspects ?? DEFAULT_ASPECTS).map(text => aspectKey(parseAspect(text)!)))
  // An imported image is named after its content, so its size and the variants already found never change: a request for one waits on no file system call.
  const importedSizes = new Map<string, { width: number, height: number }>()
  const importedVariants = new Map<string, Bun.BunFile>()

  app.get(IMAGE_ROUTE, async ({ request, server }) => {
    const url = new URL(request.url)
    const src = url.searchParams.get('src') ?? ''
    const source = await findSource(src, options, clientAddress(request, server))

    if (!source)
      return new Response('Not found', { status: 404, headers: TEXT })

    if ('status' in source)
      return new Response(source.message, { status: source.status, headers: TEXT })

    let stats: { size: number, mtimeMs: number } | undefined
    let own = source.immutable ? importedSizes.get(source.path) : undefined

    if (!own) {
      try {
        stats = await stat(source.path)
        own = await new Bun.Image(Bun.file(source.path), { maxPixels: source.immutable ? undefined : MAX_UPLOAD_PIXELS }).metadata()
      }
      catch (error) {
        if ((error as { code?: string }).code === 'ERR_IMAGE_TOO_MANY_PIXELS')
          return new Response(`Image over ${MAX_UPLOAD_PIXELS} pixels`, { status: 413, headers: TEXT })

        return stats ? new Response('Not an image kay can resize', { status: 415, headers: TEXT }) : new Response('Not found', { status: 404, headers: TEXT })
      }

      if (source.immutable)
        importedSizes.set(source.path, own)
    }

    const variant = requestedVariant(url, own, allowed)

    if (typeof variant === 'string' && variant !== 'card')
      return new Response(variant, { status: 400, headers: TEXT })

    // Both formats answer the same URL, so a cache keeps one per `Accept`.
    const negotiated = options.avif !== undefined && variant !== 'card'
    const format = negotiated && acceptsAvif(request.headers.get('accept')) ? 'avif' : 'webp'
    const headers: Record<string, string> = negotiated ? { 'cache-control': IMMUTABLE, 'vary': 'accept' } : { 'cache-control': IMMUTABLE }
    // An imported image is named after its content; a runtime one may change in place, so its size and time, read above since its size is never kept, go in the name, after its key for a remote one, whose variants go when its original does.
    const name = source.immutable ? variantName(source.path, variant, format) : inFormat(`${source.key === undefined ? '' : `remote-${source.key}-`}${Bun.hash(`${source.path}\n${stats!.size}\n${stats!.mtimeMs}`).toString(36)}${variantSuffix(variant)}`, format)
    const found = source.immutable ? importedVariants.get(name) : undefined

    if (found)
      return new Response(found, { headers })

    const built = join(options.clientDir, VARIANTS_DIR, name)
    const cached = join(options.cacheDir, name)
    let file = source.immutable && await Bun.file(built).exists() ? built : cached

    let writing = pending.get(cached)

    // Requests for a variant being written wait for that one write.
    if (file === cached && (writing || !await Bun.file(cached).exists())) {
      if (!writing) {
        writing = (async () => {
          try {
            await writeVariant(source.path, variant, cached, format === 'avif' ? options.avif : options.quality, format)
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

    if (source.immutable) {
      const variantFile = Bun.file(file)

      importedVariants.set(name, variantFile)

      return new Response(variantFile, { headers })
    }

    return revalidated(request, `W/"${name}"`, () => Bun.file(file), negotiated ? { vary: 'accept' } : {})
  })
}

// The variant a request asks for, or why it is refused: a width of the ladder below the image's own, or its own, cut or not to an allowed aspect ratio, or the share card.
function requestedVariant(url: URL, own: { width: number, height: number }, allowed: ReadonlySet<string>): ImageVariant | string {
  if (url.searchParams.has('card'))
    return 'card'

  const crop = url.searchParams.get('crop')
  let aspect: Aspect | undefined

  if (crop !== null) {
    aspect = parseAspect(crop)

    if (!aspect || !allowed.has(aspectKey(aspect)))
      return `Aspect ratio ${crop} is none of ${[...allowed].join(', ')}, which images.aspects lists`
  }

  const width = Number(url.searchParams.get('w'))
  const most = aspect ? croppedSize(own, aspect).width : own.width

  if (!Number.isInteger(width) || (width !== most && !(LADDER.has(width) && width < most)))
    return `Width ${url.searchParams.get('w')} is neither one of ${IMAGE_WIDTHS.join(', ')} below the image's own nor its own, ${most}`

  return aspect ? { width, aspect } : { width }
}

// The file a `src` names, a remote image's downloaded copy included, or why the remote one is refused.
export async function findSource(src: string, options: ImageRouteOptions, client?: string): Promise<{ path: string, immutable: boolean, key?: string } | { status: number, message: string } | undefined> {
  const local = sourceFile(src, options)

  if (local || !options.remote || !REMOTE_URL.test(src) || !RESIZABLE.test(src))
    return local

  const original = await options.remote(src, client)

  return 'path' in original ? { path: original.path, immutable: false, key: original.key } : original
}

// The file a `src` names, never one outside the built assets or the directories of runtime images.
export function sourceFile(src: string, options: ImageRouteOptions): { path: string, immutable: boolean } | undefined {
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

// `images.maxDensity`, `images.aspects` and `images.remote`, checked and set for every image this process renders, served or prerendered; returns the density.
export function applyImageConfig(images: { maxDensity?: number, aspects?: string[], remote?: string[] } | undefined): number {
  const maxDensity = images?.maxDensity ?? DEFAULT_MAX_DENSITY

  if (!(maxDensity >= 1))
    throw new Error(`images.maxDensity is ${maxDensity}: it is at least 1, or Infinity to leave the browser's choice`)

  const patterns = remotePatterns(images?.remote)

  setMaxDensity(maxDensity)
  setAspects(images?.aspects ?? DEFAULT_ASPECTS)
  setRemoteImages(src => remoteAllowed(src, patterns))

  return maxDensity
}

// The variants of remote images a static export's pages link, downloaded and written beside the others; returns how many were encoded. One the host fails to give fails the build, since no route would make it later.
export async function writeRemoteVariants(clientDir: string, remote: RemoteImages, quality = DEFAULT_QUALITY): Promise<number> {
  let encoded = 0

  for (const { src, name, variant } of requestedRemoteVariants()) {
    const target = join(clientDir, VARIANTS_DIR, name)

    if (await Bun.file(target).exists())
      continue

    const original = await remote(src)

    if ('status' in original)
      throw new Error(`kay: a page links ${src}, which the build could not download: ${original.message}`)

    await imageSize(Bun.file(original.path))
    await writeVariant(original.path, variant, target, quality)
    encoded++
  }

  return encoded
}

export interface ProcessImageOptions {
  // The box the image is resized to: it fits inside, never enlarged, unless `fit: 'cover'` fills it whole, its middle kept. One side alone keeps the image's shape.
  width?: number
  height?: number
  fit?: 'inside' | 'cover'
  format?: 'webp' | 'jpeg' | 'png'
  // 1 to 100, 80 by default.
  quality?: number
  // Refused past that many pixels, read from the header before any is decoded: 50 million by default.
  maxPixels?: number
}

export interface ProcessedImage {
  bytes: Uint8Array
  width: number
  height: number
  // Its MIME type, `image/webp`.
  type: string
}

// An image a user uploaded, resized and encoded for the app to store: `await processImage(file, { width: 200, height: 200, fit: 'cover' })` squares it to a 200px WebP.
export async function processImage(input: Blob | Uint8Array | ArrayBuffer, options: ProcessImageOptions = {}): Promise<ProcessedImage> {
  const source = input instanceof ArrayBuffer ? new Uint8Array(input) : input
  const { width: ownWidth, height: ownHeight } = await imageSize(source, options)
  const format = options.format ?? 'webp'
  const quality = options.quality ?? DEFAULT_QUALITY
  let image: Bun.Image

  if (options.fit === 'cover') {
    if (options.width === undefined || options.height === undefined)
      throw new Error('kay: processImage() covers a box given both its width and its height')

    image = new Bun.Image(await coverImage(source, options.width, options.height, options.maxPixels ?? MAX_UPLOAD_PIXELS))
  }
  else {
    image = new Bun.Image(source, { maxPixels: options.maxPixels ?? MAX_UPLOAD_PIXELS })

    if (options.width !== undefined || options.height !== undefined)
      image = image.resize(options.width ?? ownWidth, options.height ?? ownHeight, { fit: 'inside', withoutEnlargement: true })
  }

  const bytes = await (format === 'png' ? image.png() : image[format]({ quality })).bytes()
  const { width, height } = await new Bun.Image(bytes).metadata()

  return { bytes, width, height, type: `image/${format}` }
}

// An image's size and format, from its header, refused past `maxPixels`, 50 million by default.
export async function imageSize(input: Blob | Uint8Array | ArrayBuffer, options: { maxPixels?: number } = {}): Promise<{ width: number, height: number, format: string }> {
  return new Bun.Image(input instanceof ArrayBuffer ? new Uint8Array(input) : input, { maxPixels: options.maxPixels ?? MAX_UPLOAD_PIXELS }).metadata()
}
