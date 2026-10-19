import type { Context, Elysia } from 'elysia'
import type { Guard, GuardContext } from '../runtime'
import type { Aspect, ImageVariant } from '../runtime/image'
import type { ActionOptions, GuardedRequest } from './actions'
import type { LoadedGuard } from './guards'
import type { RemoteImages } from './remote'
import type { HeaderCopies } from './security'
import { existsSync } from 'node:fs'
import { readdir, rm, stat, utimes } from 'node:fs/promises'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { ASSET_PREFIX } from '../build/assets'
import { countCache } from '../build/cache'
import { writeAtomically } from '../build/files'
import { KayError } from '../compiler/errors'
import { aspectKey, CARD, croppedSize, cutOrBelow, DEFAULT_ASPECTS, DEFAULT_MAX_DENSITY, defaultLadder, FILES_ROUTE, IMAGE_ROUTE, imageWidths, ladderFor, parseAspect, QUALITY_STEP, recordVariants, requestedRemoteVariants, requestedVariants, RESIZABLE, setAspects, setImageWidths, setMaxDensity, setRemoteImages, setResolvedImages, SMALL_STEP, validQuality, variantHeight, variantSuffix } from '../runtime/image'
import { kayLog } from '../runtime/log'
import { inLocale, passGuards } from './actions'
import { AVIF_ENCODER, AVIF_SPEED, DEFAULT_AVIF_QUALITY, encodeAvif } from './avif'
import { coverImage } from './crop'
import { decodable, imageHeader } from './image-format'
import { limiter } from './limit'
import { clientAddress } from './protection'
import { revalidated } from './public'
import { remoteAllowed, remotePatterns, remoteVariants } from './remote'
import { requestUrl } from './request-url'
import { decodePath } from './routes'
import { headerCopies, ownHeaders } from './security'
import { storedImage } from './storage'

export interface ImageRouteOptions {
  // The built client, where imported images and the variants `kay build` made live.
  clientDir: string
  // Where variants made on request are kept.
  cacheDir: string
  // Directories of images added at runtime, by the URL path they are served at, the directories absolute.
  dirs?: Record<string, string> | undefined
  quality?: number | undefined
  // AVIF quality, which a request whose `Accept` names `image/avif` gets instead of WebP; none serves WebP alone.
  avif?: number | undefined
  // The aspect ratios variants are cut to, `images.aspects`.
  aspects?: readonly string[] | undefined
  // Downloads an image from a host `images.remote` lists.
  remote?: RemoteImages | undefined
  // The security headers, which the route's answers carry themselves.
  security?: Record<string, string> | undefined
  // `images.resolve`, giving an absolute path, run after `images.guard` in the request's locale, as `actions` set it.
  resolve?: { find: (src: string, ctx: GuardContext) => Promise<string | undefined>, guard?: Guard | undefined, actions: ActionOptions } | undefined
}

export const VARIANTS_DIR = 'images'
// A variant made on request that nothing wrote for this long is dropped, and the next request for it draws it again: the folder holds a version of each image per size, so one whose source changed or went away would stay for good.
export const VARIANT_KEEP_MS = 30 * 24 * 3_600_000
const PRUNE_EVERY_MS = 24 * 3_600_000
const ASSETS_PATH = `${ASSET_PREFIX}assets/`
const IMMUTABLE = 'public, max-age=31536000, immutable'
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
const REMOTE_URL = /^https?:\/\//i
const QUALITY = /^\d{1,3}$/
const WEBP_EXTENSION = /\.webp$/
// How many imported variants are kept by the URL that asked for them; a URL can be spelled many ways, so past this the lot is dropped.
const MOST_ANSWERED = 1024
// A longer URL is answered without being kept, so junk query strings cannot pin megabytes.
const LONGEST_ANSWERED = 2048

// About 50 megapixels: a runtime image larger than that, which could take gigabytes to decode, is refused before any pixel is read.
export const MAX_UPLOAD_PIXELS = 50_000_000
export const DEFAULT_QUALITY = 80
// Variants and cards drawn on request, each holding its source's decoded pixels, at most this many at once, so a burst of new images cannot take the memory of all of them.
export const drawing = limiter(4)
// Images a build decodes at once, each held whole while its variants are written from it.
const DECODED_AT_ONCE = 4

export type VariantFormat = 'webp' | 'avif'

// The file name of one variant of an image the build or the route wrote, a width of the ladder by default.
export function variantName(source: string, variant: number | ImageVariant, format: VariantFormat = 'webp'): string {
  return inFormat(`${basename(source, extname(source))}${variantSuffix(typeof variant === 'number' ? { width: variant } : variant)}`, format)
}

// The WebP quality of the variants: `images.webp.quality`, else `images.quality`, else the default applied where it is read.
export function webpQuality(images: { quality?: number | undefined, webp?: { quality?: number | undefined } | undefined } | undefined): number | undefined {
  return images?.webp?.quality ?? images?.quality
}

// `images.avif` as a quality, or undefined when it is off.
export function avifQuality(images: { avif?: false | { quality?: number | undefined } | undefined } | undefined): number | undefined {
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

// The quality a variant is encoded at in a format: its own for WebP, and for AVIF the same step above the AVIF default as it is above the WebP one, as AVIF at the WebP number would be larger than it needs to be.
export function variantLevel(variant: number | ImageVariant, format: VariantFormat, webp: number, avif: number): number {
  const own = typeof variant === 'object' ? variant.quality : undefined

  if (format === 'webp')
    return own ?? webp

  return own === undefined ? avif : Math.min(100, Math.max(1, own + avif - webp))
}

// `source` is a path, or an image already decoded, such as to an uncompressed PNG. `quality` is the one to encode at, see `variantLevel`.
export async function writeVariant(source: string | Blob | Uint8Array, variant: number | ImageVariant, target: string, quality = DEFAULT_QUALITY, format: VariantFormat = 'webp'): Promise<void> {
  // Read through Bun.file, which also reaches the files an executable embeds, where Bun.Image given a path does not.
  const file = typeof source === 'string' ? await decodable(Bun.file(source)) : source
  const shape = typeof variant === 'number' ? { width: variant } : variant

  await writeAtomically(target, async (partial) => {
    if (shape === 'card') {
      await new Bun.Image(await coverImage(file, CARD.width, CARD.height)).jpeg({ quality }).write(partial)

      return
    }

    const image = shape.aspect ? new Bun.Image(await coverImage(file, shape.width, variantHeight(shape.width, shape.aspect))) : new Bun.Image(file).resize(shape.width, undefined, { withoutEnlargement: true })

    await (format === 'avif' ? Bun.write(partial, await encodeAvif(image, quality)) : image.webp({ quality }).write(partial))
  })
}

// Every width of the ladder below an imported image's own, and its own, written next to the build for the route to serve as files, with the crops and share cards pages asked for, each in AVIF too given its quality; returns how many were encoded.
// With a cache directory, a variant an earlier build encoded is copied from it, and what this build no longer uses is pruned from it, unless `prune` is off for a pass that sees only some of the build's images.
// `onImage` hears of each source image once its variants are written, with how many there are.
export async function writeImageVariants(clientDir: string, quality = DEFAULT_QUALITY, cacheDir?: string, { prune = true, avif, onImage }: { prune?: boolean | undefined, avif?: number | undefined, onImage?: ((done: number, total: number) => void) | undefined } = {}): Promise<number> {
  const assets = join(clientDir, 'assets')
  const used = new Set<string>()
  let encoded = 0

  if (!existsSync(assets))
    return encoded

  const resizable = (await readdir(assets)).filter(name => RESIZABLE.test(name))
  const decoding = limiter(DECODED_AT_ONCE)
  let done = 0
  const writeVariants = async (name: string) => decoding(async () => {
    const source = join(assets, name)
    const { width, animated } = await imageHeader(Bun.file(source))

    // Imported, an animated GIF is linked as it is, with no variants.
    if (animated)
      return

    // A width below the ladder a page asked for may be the image's own, written already.
    const variants = [...ladderFor(width), ...requestedVariants(name).filter(variant => cutOrBelow(variant, width))]
    // The share card stays a JPEG, which social sites read best.
    const encodings = variants.flatMap(variant => [{ variant, format: 'webp' as const, level: String(variantLevel(variant, 'webp', quality, avif ?? DEFAULT_AVIF_QUALITY)) }, ...avif === undefined || variant === 'card' ? [] : [{ variant, format: 'avif' as const, level: `${variantLevel(variant, 'avif', quality, avif)}s${AVIF_SPEED}-${AVIF_ENCODER}` }]])
    const missing: { variant: number | ImageVariant, format: VariantFormat, target: string, cached: string | undefined }[] = []

    await Promise.all(encodings.map(async ({ variant, format, level }) => {
      const target = join(clientDir, VARIANTS_DIR, variantName(name, variant, format))
      // Asset names carry a hash of their content, so a cached variant only goes stale when the quality, the AVIF encoder or its speed changes.
      const cachedName = `${level}-${variantName(name, variant, format)}`
      const cached = cacheDir !== undefined && cacheDir !== '' ? join(cacheDir, cachedName) : undefined

      used.add(cachedName)

      if (await Bun.file(target).exists())
        return

      if (cached !== undefined && await Bun.file(cached).exists()) {
        countCache('image variants', true)
        await Bun.write(target, Bun.file(cached))
      }
      else {
        countCache('image variants', false)
        missing.push({ variant, format, target, cached })
      }
    }))

    if (missing.length === 0)
      return

    // Decoded once for all its variants, each width and format resizing these pixels rather than decoding the source again.
    const decoded = await new Bun.Image(await decodable(Bun.file(source))).png({ compressionLevel: 0 }).bytes()

    await Promise.all(missing.map(async ({ variant, format, target, cached }) => {
      await writeVariant(decoded, variant, cached ?? target, variantLevel(variant, format, quality, avif ?? DEFAULT_AVIF_QUALITY), format)
      encoded++

      if (cached !== undefined)
        await Bun.write(target, Bun.file(cached))
    }))
  })

  if (resizable.length > 0)
    onImage?.(0, resizable.length)

  await Promise.all(resizable.map(async (name) => {
    await writeVariants(name)
    onImage?.(++done, resizable.length)
  }))

  if (prune && cacheDir !== undefined && cacheDir !== '' && existsSync(cacheDir))
    await Promise.all((await readdir(cacheDir)).filter(name => !used.has(name)).map(async name => rm(join(cacheDir, name), { force: true })))

  return encoded
}

// `/_kay/image?src=...&w=640` answers a WebP, or an AVIF to a browser that reads it when `avif` is set, of an imported image, or of one in a directory of runtime images or on a host `images.remote` lists, at a width of the ladder, a multiple of 16 below it or its own; `&crop=16x9` cuts it to an aspect ratio `images.aspects` allows, and `?src=...&card` answers its 1200x630 JPEG share card.
export function serveImages(app: Elysia, options: ImageRouteOptions): void {
  const pending = new Map<string, Promise<void>>()
  const allowed = new Set((options.aspects ?? DEFAULT_ASPECTS).map(text => aspectKey(parseAspect(text)!)))
  // An imported image is named after its content, so its size and the variants already found never change: a request for one waits on no file system call.
  const importedSizes = new Map<string, { width: number, height: number, format: string, animated: boolean }>()
  // The AVIF sources variants are being written from, by version, decoded once for all of them.
  const decodedAvif = new Map<string, { png?: Promise<Blob | Uint8Array>, writers: number }>()
  const importedVariants = new Map<string, Bun.BunFile>()
  const runtimeSizes = new Map<string, { width: number, height: number, format: string, animated: boolean }>()
  // An imported variant by the URL that asked for it and whether its `Accept` takes AVIF, so a repeated request skips parsing the URL.
  const answered = new Map<string, { file: Bun.BunFile, headers: HeaderCopies }>()
  const text = headerCopies(TEXT, options.security)
  const immutable = headerCopies({ 'cache-control': IMMUTABLE }, options.security)
  const negotiatedImmutable = headerCopies({ 'cache-control': IMMUTABLE, 'vary': 'accept' }, options.security)
  const revalidatedAs = headerCopies({}, options.security)
  const negotiatedRevalidated = headerCopies({ vary: 'accept' }, options.security)

  let pruning: ReturnType<typeof setInterval> | undefined

  const prune = async () => {
    try {
      // The files the maps point at may be among those gone.
      if (await pruneVariants(options.cacheDir, VARIANT_KEEP_MS) > 0) {
        answered.clear()
        importedVariants.clear()
      }
    }
    catch (error) {
      kayLog('warn', `the variants made on request cannot be pruned in ${options.cacheDir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  app.onStart(() => {
    void prune()
    pruning = setInterval(() => void prune(), PRUNE_EVERY_MS)
    pruning.unref()
  })
  app.onStop(() => clearInterval(pruning))

  app.get(IMAGE_ROUTE, async (context) => {
    const { request, server, set } = context
    const key = options.avif === undefined ? request.url : `${request.url}\n${acceptsAvif(request.headers.get('accept'))}`
    const known = answered.get(key)

    if (known)
      return new Response(known.file, { headers: ownHeaders(set, known.headers) })

    let passed: GuardedRequest | undefined
    // What the guards set goes out with every answer they let through.
    const guarded = (response: Response) => {
      for (const [name, value] of passed?.headers ?? [])
        response.headers[name === 'set-cookie' ? 'append' : 'set'](name, value)

      passed?.jar.writeTo(response.headers)

      return response
    }
    const fail = (body: string, status: number) => guarded(new Response(body, { status, headers: ownHeaders(set, text) }))

    const url = requestUrl(request)
    const src = url.searchParams.get('src') ?? ''
    let source = await findSource(src, options, clientAddress(request, server))

    if (!source && options.resolve) {
      // The guards get a copy of the context: Elysia's Sucrose reads a handler passing its whole context to a function, `context,` or `context)`, as using all of it, so it would parse the cookies of every request and copy every response for the jar that sets.
      const found = await resolvedSource(src, { ...context }, options.resolve)

      if (found instanceof Response) {
        for (const [name, value] of Object.entries(options.security ?? {})) {
          if (!found.headers.has(name))
            found.headers.set(name, value)
        }

        found.headers.set('cache-control', 'private, no-store')

        return found
      }

      source = found?.source
      passed = found?.passed
    }

    if (!source)
      return fail('Not Found', 404)

    if ('status' in source)
      return fail(source.message, source.status)

    const { path } = source
    let stats: { size: number, mtimeMs: number } | undefined
    let own = source.immutable ? importedSizes.get(path) : undefined
    let runtimeKey: string | undefined

    if (!own) {
      try {
        stats = await stat(path)
        // A runtime image may change in place, so its header is kept by the size and time just read.
        runtimeKey = source.immutable ? undefined : `${path}\n${stats.size}\n${stats.mtimeMs}`
        own = runtimeKey === undefined ? undefined : runtimeSizes.get(runtimeKey)
        own ??= await imageHeader(Bun.file(path), source.immutable ? undefined : MAX_UPLOAD_PIXELS)
      }
      catch (error) {
        if ((error as { code?: string }).code === 'ERR_IMAGE_TOO_MANY_PIXELS')
          return fail(`Image over ${MAX_UPLOAD_PIXELS} pixels`, 413)

        return stats ? fail('Not an image kay can resize', 415) : fail('Not Found', 404)
      }

      if (source.immutable)
        importedSizes.set(path, own)
      else if (runtimeKey !== undefined)
        keep(runtimeSizes, runtimeKey, own)
    }

    const variant = requestedVariant(url, own, allowed)

    if (typeof variant === 'string' && variant !== 'card')
      return fail(variant, 400)

    // Its URL may carry a signed link, or `images.resolve` admit only some, so no shared cache keeps it.
    const answer = (response: Response) => {
      if (source.private === true)
        response.headers.set('cache-control', 'private, no-cache')

      return guarded(response)
    }

    // An animated GIF goes as it is at every width, a variant flattening it to its first frame; its card is still drawn from that frame.
    if (own.animated && variant !== 'card') {
      const original = Bun.file(path, { type: 'image/gif' })

      if (source.immutable)
        return remembered(key, original, immutable, set)

      return answer(revalidated(request, `W/"${Bun.hash(`${path}\n${stats!.size}\n${stats!.mtimeMs}`).toString(36)}"`, () => original, ownHeaders(set, revalidatedAs)))
    }

    // Both formats answer the same URL, so a cache keeps one per `Accept`.
    const negotiated = options.avif !== undefined && variant !== 'card'
    const format = negotiated && acceptsAvif(request.headers.get('accept')) ? 'avif' : 'webp'
    const headers = negotiated ? negotiatedImmutable : immutable
    // An imported image is named after its content; a runtime one may change in place, so its size and time, read above since its size is never kept, go in the name, after the prefix of a remote or stored one, whose variants go when its original does.
    const name = source.immutable ? variantName(path, variant, format) : inFormat(`${source.prefix ?? ''}${Bun.hash(`${path}\n${stats!.size}\n${stats!.mtimeMs}`).toString(36)}${variantSuffix(variant)}`, format)
    const found = source.immutable ? importedVariants.get(name) : undefined

    if (found)
      return remembered(key, found, headers, set)

    const built = join(options.clientDir, VARIANTS_DIR, name)
    const cached = join(options.cacheDir, name)
    let file = source.immutable && await Bun.file(built).exists() ? built : cached

    let writing = pending.get(cached)

    // Requests for a variant being written wait for that one write.
    if (file === cached && (writing || !await touched(cached))) {
      if (!writing) {
        // Counted before it waits its turn, so the variants a burst asks for share the decode.
        const version = `${path}\n${stats?.size}\n${stats?.mtimeMs}`
        const decoding = own.format === 'avif' ? decodedAvif.get(version) ?? { writers: 0 } : undefined

        if (decoding) {
          decoding.writers++
          decodedAvif.set(version, decoding)
        }

        writing = (async () => {
          try {
            await drawing(async () => {
              const decoded = decoding ? await (decoding.png ??= decodable(Bun.file(path), source.immutable ? undefined : MAX_UPLOAD_PIXELS)) : path

              await writeVariant(decoded, variant, cached, variantLevel(variant, format, options.quality ?? DEFAULT_QUALITY, options.avif ?? DEFAULT_AVIF_QUALITY), format)
            })
          }
          finally {
            pending.delete(cached)

            if (decoding && --decoding.writers === 0)
              decodedAvif.delete(version)
          }
        })()
        pending.set(cached, writing)
      }

      try {
        await writing
      }
      catch (error) {
        // A full or unwritable cache directory is the server's failure, which its error log reports, not the image's.
        if (typeof (error as { syscall?: unknown }).syscall === 'string')
          throw error

        return fail('Not an image kay can resize', 415)
      }

      file = cached
    }

    if (source.immutable) {
      const variantFile = Bun.file(file)

      importedVariants.set(name, variantFile)

      return remembered(key, variantFile, headers, set)
    }

    return answer(revalidated(request, `W/"${name}"`, () => Bun.file(file), ownHeaders(set, negotiated ? negotiatedRevalidated : revalidatedAs)))
  })

  // The oldest entry goes when the map is full, where emptying it would drop every key kept warm.
  function keep<T>(map: Map<string, T>, key: string, value: T): void {
    if (map.size >= MOST_ANSWERED && !map.has(key))
      map.delete(map.keys().next().value!)

    map.set(key, value)
  }

  function remembered(key: string, file: Bun.BunFile, headers: HeaderCopies, set: Context['set']): Response {
    if (key.length <= LONGEST_ANSWERED) {
      keep(answered, key, { file, headers })
    }

    return new Response(file, { headers: ownHeaders(set, headers) })
  }
}

// Whether a cached variant exists, marking it as just used so the prune that may run meanwhile leaves it, and a request finding it gone writes it again.
async function touched(file: string): Promise<boolean> {
  try {
    const now = new Date()

    await utimes(file, now, now)

    return true
  }
  catch {
    return false
  }
}

// Removes the files of `dir`, not its folders, that nothing wrote for `keepMs`; returns how many went.
export async function pruneVariants(dir: string, keepMs: number): Promise<number> {
  if (!existsSync(dir))
    return 0

  const oldest = Date.now() - keepMs
  let removed = 0

  await Promise.all((await readdir(dir, { withFileTypes: true })).filter(entry => entry.isFile()).map(async ({ name }) => {
    const file = join(dir, name)

    try {
      // Read again just before removing, so a variant a request touched since the first read stays.
      if ((await stat(file)).mtimeMs < oldest && (await stat(file)).mtimeMs < oldest) {
        await rm(file, { force: true })
        removed++
      }
    }
    catch {
      // Gone already, or taken by another process.
    }
  }))

  return removed
}

// The variant a request asks for, or why it is refused: a width of the ladder or a multiple of `SMALL_STEP` below it, narrower than the image's own, or its own, cut or not to an allowed aspect ratio, or the share card.
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

  const asked = url.searchParams.get('q')
  let quality: number | undefined

  if (asked !== null) {
    quality = QUALITY.test(asked) ? Number(asked) : undefined

    if (quality === undefined || !validQuality(quality))
      return `Quality ${asked} is not a multiple of ${QUALITY_STEP} from ${QUALITY_STEP} to 100`
  }

  const width = Number(url.searchParams.get('w'))
  const most = aspect ? croppedSize(own, aspect).width : own.width
  const steps = imageWidths()

  if (!Number.isInteger(width) || !((madeWidth(width) && width < most) || (width === most && (!defaultLadder() || most <= steps.at(-1)!))))
    return `Width ${url.searchParams.get('w')} is neither one of ${steps.join(', ')} or a multiple of ${SMALL_STEP} under ${steps[0]} below the image's own, nor its own, ${most}`

  return { width, ...aspect && { aspect }, ...quality !== undefined && { quality } }
}

function madeWidth(width: number): boolean {
  const steps = imageWidths()

  return steps.includes(width) || (width > 0 && width < steps[0]! && width % SMALL_STEP === 0)
}

// The WebP variant `kay build` wrote for an image route URL naming an imported image, or undefined for any other.
export async function builtVariant(url: URL, clientDir: string, aspects?: readonly string[]): Promise<string | undefined> {
  const source = sourceFile(url.searchParams.get('src') ?? '', { clientDir, cacheDir: clientDir })

  if (!source?.immutable)
    return undefined

  try {
    const variant = requestedVariant(url, await imageHeader(Bun.file(source.path)), new Set((aspects ?? DEFAULT_ASPECTS).map(text => aspectKey(parseAspect(text)!))))
    const file = typeof variant === 'string' ? undefined : join(clientDir, VARIANTS_DIR, variantName(source.path, variant))

    return file !== undefined && await Bun.file(file).exists() ? file : undefined
  }
  catch {
    return undefined
  }
}

// The file `images.resolve` gives for a `src`, once `images.guard` let the request through, or the answer of the one that stopped it.
async function resolvedSource(src: string, context: { request: Request }, { find, guard, actions }: NonNullable<ImageRouteOptions['resolve']>): Promise<Response | { source: { path: string, immutable: false, private: true }, passed: GuardedRequest } | undefined> {
  let path: string | undefined
  const lookup: LoadedGuard = { file: 'images.resolve', special: {}, check: async (ctx) => {
    path = await find(src, ctx)
  } }
  const guards = guard ? [{ file: 'images.guard', special: {}, check: guard }, lookup] : [lookup]
  const passed = await inLocale(context.request, actions, async () => passGuards(guards, context, {}, actions))

  if (passed instanceof Response)
    return passed

  return path === undefined ? undefined : { source: { path, immutable: false, private: true }, passed }
}

// The file a `src` names, a remote image's downloaded copy or a stored one included, or why the remote or private one is refused.
export async function findSource(src: string, options: ImageRouteOptions, client?: string): Promise<{ path: string, immutable: boolean, prefix?: string, private?: boolean } | { status: number, message: string } | undefined> {
  if (src.startsWith(FILES_ROUTE))
    return RESIZABLE.test(src) ? storedImage(src) : undefined

  const local = sourceFile(src, options)

  if (local || !options.remote || !REMOTE_URL.test(src) || !RESIZABLE.test(src))
    return local

  const original = await options.remote(src, client)

  return 'path' in original ? { path: original.path, immutable: false, prefix: remoteVariants(original.key) } : original
}

// The file a built asset's name stands for, never one outside the built assets.
export function builtAsset(clientDir: string, name: string | undefined): string | undefined {
  if (name === undefined || name.includes('\0'))
    return undefined

  const dir = join(clientDir, 'assets')
  const path = normalize(resolve(dir, name))

  return path.startsWith(dir + sep) ? path : undefined
}

// The file a `src` names, never one outside the built assets or the directories of runtime images.
export function sourceFile(src: string, options: ImageRouteOptions): { path: string, immutable: boolean } | undefined {
  const decoded = decodePath(src)

  if (decoded === undefined || decoded.includes('\0') || !RESIZABLE.test(decoded))
    return undefined

  if (src.startsWith(ASSETS_PATH)) {
    const path = builtAsset(options.clientDir, decodePath(src.slice(ASSETS_PATH.length)))

    return path === undefined ? undefined : { path, immutable: true }
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

// `images.maxDensity`, `images.widths`, `images.aspects`, `images.remote` and whether `images.resolve` is set, checked and set for every image this process renders, served or prerendered; returns the density.
export function applyImageConfig(images: { maxDensity?: number | undefined, widths?: number[] | undefined, aspects?: string[] | undefined, remote?: string[] | undefined, resolve?: unknown, guard?: unknown } | undefined): number {
  const maxDensity = images?.maxDensity ?? DEFAULT_MAX_DENSITY

  if (images?.guard !== undefined && images.resolve === undefined)
    throw new KayError('image-invalid', 'kay: images.guard admits the images images.resolve looks up, and images.resolve is not set')

  if (!(maxDensity >= 1))
    throw new Error(`images.maxDensity is ${maxDensity}: it is at least 1, or Infinity to leave the browser's choice`)

  const patterns = remotePatterns(images?.remote)

  setMaxDensity(maxDensity)
  setImageWidths(images?.widths)
  setAspects(images?.aspects ?? DEFAULT_ASPECTS)
  setRemoteImages(src => remoteAllowed(src, patterns))
  setResolvedImages(images?.resolve !== undefined)
  recordVariants()

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
      throw new KayError('image-invalid', `kay: a page links ${src}, which the build could not download: ${original.message}`)

    await imageSize(Bun.file(original.path))
    await writeVariant(original.path, variant, target, variantLevel(variant, 'webp', quality, DEFAULT_AVIF_QUALITY))
    encoded++
  }

  return encoded
}

export interface ProcessImageOptions {
  // The box the image is resized to: it fits inside, never enlarged, unless `fit: 'cover'` fills it whole, its middle kept. One side alone keeps the image's shape.
  width?: number | undefined
  height?: number | undefined
  fit?: 'inside' | 'cover' | undefined
  format?: 'webp' | 'jpeg' | 'png' | undefined
  // 1 to 100, 80 by default.
  quality?: number | undefined
  // Refused past that many pixels, read from the header before any is decoded: 50 million by default.
  maxPixels?: number | undefined
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
  const maxPixels = options.maxPixels ?? MAX_UPLOAD_PIXELS
  const { width: ownWidth, height: ownHeight } = await imageSize(source, options)
  const format = options.format ?? 'webp'
  const quality = options.quality ?? DEFAULT_QUALITY
  let image: Bun.Image

  if (options.fit === 'cover') {
    if (options.width === undefined || options.height === undefined)
      throw new KayError('image-invalid', 'kay: processImage() covers a box given both its width and its height')

    image = new Bun.Image(await coverImage(source, options.width, options.height, maxPixels))
  }
  else {
    image = new Bun.Image(await decodable(source, maxPixels), { maxPixels })

    if (options.width !== undefined || options.height !== undefined)
      image = image.resize(options.width ?? ownWidth, options.height ?? ownHeight, { fit: 'inside', withoutEnlargement: true })
  }

  const bytes = await (format === 'png' ? image.png() : image[format]({ quality })).bytes()
  const { width, height } = await new Bun.Image(bytes).metadata()

  return { bytes, width, height, type: `image/${format}` }
}

// An image's size and format, from its header, refused past `maxPixels`, 50 million by default.
export async function imageSize(input: Blob | Uint8Array | ArrayBuffer, options: { maxPixels?: number | undefined } = {}): Promise<{ width: number, height: number, format: string }> {
  const { width, height, format } = await imageHeader(input instanceof ArrayBuffer ? new Uint8Array(input) : input, options.maxPixels ?? MAX_UPLOAD_PIXELS)

  return { width, height, format }
}
