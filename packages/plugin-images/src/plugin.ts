// @kayjs/images — Build-time AVIF/WebP responsive image optimization with content-hashed disk cache.
// Built strictly on the public KayPlugin API (bunPlugins + build(ctx).emitAsset).

import type { BunPlugin } from 'bun'
import type { KayPlugin } from '@kayjs/kay/config'
import type { ShareCardDefaults } from './card'
import type { ImageAsset } from './helpers'
import type { CachedImageMeta, VariantPipelineConfig } from './pipeline'
import type { RuntimeImageStore } from './runtime'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { CONTENT_IMAGE_RESOLVER_SERVICE, definePlugin, isInside } from '@kayjs/kay/config'
import { getAppContext } from '@kayjs/kay/internal/server'
import { SHARE_CARD_CONFIG_SERVICE } from './card'
import {
  ALLOWED_IMAGE_EXTS,
  assembleImageAsset,
  computeImageKey,
  encodeVariantAsync,
  identifyImageAsync,

  mapConcurrent,
  MAX_ENCODE_CONCURRENCY,
  planVariantJobs,
  readCachedMeta,
  writeFileAtomic,
} from './pipeline'
import {
  computeEtag,
  createRuntimeImageStore,
  encodeVariantToBytesAsync,
  enterBuildPhase,
  flushBuildPhase,
  hasMagick,
  isBuildPhase,
  leaveBuildPhase,
  mimeForImageExt,
  queueBuildTask,
  registerRuntimeImageMiddleware,
  RUNTIME_IMAGE_STORE_SERVICE,
} from './runtime'

export { CONTENT_IMAGE_RESOLVER_SERVICE }

export interface ImagesPluginOptions {
  widths?: number[] | undefined
  formats?: ('avif' | 'webp')[] | undefined
  quality?: number | undefined
  avifQuality?: number | undefined
  cacheDir?: string | undefined
  /** Remove stale cache files unused by the current build (default: true). */
  pruneCache?: boolean | undefined
  /** Optional defaults for build-time `shareCard()` OG image generation. */
  card?: ShareCardDefaults | undefined
  /** Default `sizes` attribute for relative images auto-optimized inside `@kayjs/content` Markdown. */
  markdownSizes?: string | undefined
}

const DEFAULT_WIDTHS = [320, 640, 960, 1280, 1920]
const DEFAULT_FORMATS: ('avif' | 'webp')[] = ['avif', 'webp']
const MISSING_MAGICK_MESSAGE = '@kayjs/images: ImageMagick ("magick") was not found on PATH; AVIF/WebP optimization is disabled. Install ImageMagick to enable responsive image optimization.'

/** Pure-JS binary header parser for PNG, GIF, WebP, JPEG, and AVIF/HEIF dimensions (zero external dependencies). */
export function readImageDimensions(bytes: Uint8Array): { width: number, height: number } | undefined {
  const len = bytes.byteLength
  if (len < 10)
    return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, len)

  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width@16, height@20 (uint32BE)
  if (len >= 24 && view.getUint32(0) === 0x89504E47 && view.getUint32(4) === 0x0D0A1A0A) {
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    return width > 0 && height > 0 ? { width, height } : undefined
  }

  // GIF87a / GIF89a: width@6, height@8 (uint16LE)
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    const width = view.getUint16(6, true)
    const height = view.getUint16(8, true)
    return width > 0 && height > 0 ? { width, height } : undefined
  }

  // WebP: RIFF....WEBP
  if (len >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    const chunk = view.getUint32(12)
    // VP8X extended
    if (chunk === 0x56503858 && len >= 30) {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    // VP8L lossless
    if (chunk === 0x5650384C && len >= 25 && bytes[20] === 0x2F) {
      const bits = view.getUint32(21, true)
      const width = (bits & 0x3FFF) + 1
      const height = ((bits >> 14) & 0x3FFF) + 1
      return width > 0 && height > 0 ? { width, height } : undefined
    }
    // VP8 lossy
    if (chunk === 0x56503820 && len >= 30 && bytes[23] === 0x9D && bytes[24] === 0x01 && bytes[25] === 0x2A) {
      const width = view.getUint16(26, true) & 0x3FFF
      const height = view.getUint16(28, true) & 0x3FFF
      return width > 0 && height > 0 ? { width, height } : undefined
    }
  }

  // JPEG: FF D8 followed by markers; SOF0..SOF15 (except C4, C8, CC) carry height@+5, width@+7
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let offset = 2
    while (offset + 4 <= len) {
      if (bytes[offset] !== 0xFF)
        break
      while (offset < len && bytes[offset] === 0xFF) offset++
      if (offset >= len)
        break
      const marker = bytes[offset++]!
      if (marker === 0xD9 || marker === 0xDA)
        break
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7))
        continue
      if (offset + 2 > len)
        break
      const segLen = view.getUint16(offset)
      if (segLen < 2 || offset + segLen > len)
        break
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC && segLen >= 7) {
        const height = view.getUint16(offset + 3)
        const width = view.getUint16(offset + 5)
        return width > 0 && height > 0 ? { width, height } : undefined
      }
      offset += segLen
    }
  }

  // AVIF / HEIF (ISOBMFF): ftyp box followed by meta -> iprp -> ipco -> ispe box (width@+12, height@+16 from box start)
  if (len >= 24 && view.getUint32(4) === 0x66747970) {
    for (let i = 12; i + 16 <= len; i++) {
      if (bytes[i] === 0x69 && bytes[i + 1] === 0x73 && bytes[i + 2] === 0x70 && bytes[i + 3] === 0x65) {
        // 'ispe' full box: 4 bytes version+flags, then uint32BE width, uint32BE height
        const width = view.getUint32(i + 8)
        const height = view.getUint32(i + 12)
        if (width > 0 && height > 0 && width <= 65535 && height <= 65535)
          return { width, height }
      }
    }
  }

  return undefined
}

interface PersistedImagesConfig {
  cacheDirRel: string
  widths: number[]
  formats: ('avif' | 'webp')[]
  quality: number
  avifQuality: number
  markdownSizes?: string | undefined
  card?: ShareCardDefaults | undefined
}

export function images(options: ImagesPluginOptions = {}): KayPlugin {
  const widths = (options.widths ?? DEFAULT_WIDTHS).slice().sort((a, b) => a - b)
  const formats = options.formats ?? DEFAULT_FORMATS
  const quality = options.quality ?? 80
  const avifQuality = options.avifQuality ?? 55
  const cacheDirRel = options.cacheDir ?? '.kay-cache/images'
  const pruneCache = options.pruneCache ?? true

  const emittedAssets = new Map<string, Uint8Array>()
  const activeCacheFiles = new Set<string>()
  let lastCacheRoot: string | undefined
  let warnedMissingMagick = false

  function warnMissingMagickOnce(): void {
    if (!warnedMissingMagick) {
      warnedMissingMagick = true
      console.warn(MISSING_MAGICK_MESSAGE)
    }
  }

  return definePlugin({
    name: '@kayjs/images',
    check(ctx) {
      if (!hasMagick())
        ctx.error(MISSING_MAGICK_MESSAGE)
    },
    bunPlugins: ({ root, assetPrefix }): BunPlugin[] => {
      const cacheRoot = resolve(root, cacheDirRel)
      lastCacheRoot = cacheRoot
      const prefix = assetPrefix.replace(/\/$/, '')
      const pipelineCfg: VariantPipelineConfig = { widths, formats, quality, avifQuality, cachePrefix: '' }
      const magickAvailable = hasMagick()
      if (!magickAvailable)
        warnMissingMagickOnce()

      return [{
        name: 'kayjs-images',
        setup(b) {
          b.onLoad({ filter: /\.(?:png|jpe?g|webp|avif)$/i }, async (args) => {
            if (args.path.includes('/node_modules/'))
              return undefined

            const rawBytes = new Uint8Array(readFileSync(args.path))
            const { hash, stem, rawFileName } = computeImageKey(args.path, rawBytes, pipelineCfg)
            const emitRaw = (width: number, height: number) => {
              const rel = `img/${rawFileName}`
              emittedAssets.set(rel, rawBytes)
              const asset: ImageAsset = { src: `${prefix}/${rel}`, width, height }
              return { contents: `export default ${JSON.stringify(asset)};\n`, loader: 'js' as const }
            }

            if (!magickAvailable) {
              const dims = readImageDimensions(rawBytes)
              if (dims === undefined)
                throw new Error(`@kayjs/images: could not determine dimensions for "${args.path}" (ImageMagick is unavailable and binary header could not be parsed)`)
              return emitRaw(dims.width, dims.height)
            }

            mkdirSync(cacheRoot, { recursive: true })
            const metaName = `${stem}-${hash}.json`
            const metaPath = join(cacheRoot, metaName)
            activeCacheFiles.add(metaName)
            let meta = readCachedMeta(metaPath, cacheRoot, '')

            if (meta === undefined) {
              const dims = await identifyImageAsync(args.path) ?? readImageDimensions(rawBytes)
              if (dims === undefined)
                throw new Error(`@kayjs/images: could not determine dimensions for "${args.path}"`)

              const jobs = planVariantJobs(dims, stem, hash, cacheRoot, pipelineCfg)
              const encoded = await mapConcurrent(jobs, MAX_ENCODE_CONCURRENCY, async (job) => {
                const ok = existsSync(job.cachedFile) || await encodeVariantAsync(args.path, job.cachedFile, job.width, job.quality)
                return ok ? { rel: `img/${job.fileName}`, width: job.width, format: job.format } : undefined
              })
              const files: CachedImageMeta['files'] = encoded.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
              if (files.length === 0)
                return emitRaw(dims.width, dims.height)

              meta = { width: dims.width, height: dims.height, files }
              writeFileAtomic(metaPath, JSON.stringify(meta))
            }

            const asset = assembleImageAsset(meta, cacheRoot, '', prefix, (rel, fileName, cachedFile) => {
              activeCacheFiles.add(fileName)
              if (!emittedAssets.has(rel))
                emittedAssets.set(rel, new Uint8Array(readFileSync(cachedFile)))
            })
            return { contents: `export default ${JSON.stringify(asset)};\n`, loader: 'js' }
          })
        },
      }]
    },
    build(ctx) {
      enterBuildPhase(ctx.outDir)
      const publicDir = join(ctx.outDir, 'public')
      const cacheDir = resolve(ctx.root, cacheDirRel)
      const cardWithSite: ShareCardDefaults | undefined = options.card !== undefined || ctx.site !== undefined
        ? { ...(ctx.site !== undefined ? { site: ctx.site } : {}), ...options.card }
        : undefined
      const persisted: PersistedImagesConfig = {
        cacheDirRel,
        widths,
        formats,
        quality,
        avifQuality,
        markdownSizes: options.markdownSizes,
        card: cardWithSite,
      }
      ctx.setData(persisted as unknown as Record<string, unknown>)
      ctx.provide(SHARE_CARD_CONFIG_SERVICE, { ...cardWithSite, publicDir, cacheDir } satisfies ShareCardDefaults)
      ctx.provide(CONTENT_IMAGE_RESOLVER_SERVICE, createMarkdownImageResolver({
        root: resolve(ctx.root),
        outPublicDir: publicDir,
        cacheDir,
        widths,
        formats,
        quality,
        avifQuality,
        sizes: options.markdownSizes,
      }))
      for (const [rel, bytes] of emittedAssets)
        ctx.emitAsset(rel, bytes)
      if (pruneCache && !ctx.dev && lastCacheRoot !== undefined && activeCacheFiles.size > 0 && existsSync(lastCacheRoot)) {
        for (const entry of readdirSync(lastCacheRoot)) {
          if (!entry.startsWith('og-') && !entry.startsWith('md-') && !activeCacheFiles.has(entry))
            rmSync(join(lastCacheRoot, entry), { force: true })
        }
      }
      emittedAssets.clear()
      activeCacheFiles.clear()
    },
    async afterPrerender(ctx) {
      await flushBuildPhase(ctx.outDir)
    },
    server(api) {
      const persisted = api.getBuildData<PersistedImagesConfig>()
      const publicDir = join(api.outDir, 'public')
      const cacheDir = resolve(api.root, persisted?.cacheDirRel ?? cacheDirRel)
      const runtimeStore = createRuntimeImageStore()
      api.provide(RUNTIME_IMAGE_STORE_SERVICE, runtimeStore)
      registerRuntimeImageMiddleware(api, runtimeStore)
      api.onShutdown(() => {
        if (isBuildPhase(api.outDir))
          leaveBuildPhase(api.outDir)
      })
      api.provide(SHARE_CARD_CONFIG_SERVICE, {
        ...(api.site !== undefined ? { site: api.site } : {}),
        ...(persisted?.card ?? options.card),
        publicDir,
        cacheDir,
      } satisfies ShareCardDefaults)
      api.provide(CONTENT_IMAGE_RESOLVER_SERVICE, createMarkdownImageResolver({
        root: resolve(api.root),
        cacheDir,
        widths: persisted?.widths ?? widths,
        formats: persisted?.formats ?? formats,
        quality: persisted?.quality ?? quality,
        avifQuality: persisted?.avifQuality ?? avifQuality,
        sizes: persisted?.markdownSizes ?? options.markdownSizes,
      }))
    },
  })
}

export interface OptimizeImageFileOptions {
  outPublicDir?: string | undefined
  cacheDir?: string | undefined
  widths?: number[] | undefined
  formats?: ('avif' | 'webp')[] | undefined
  quality?: number | undefined
  avifQuality?: number | undefined
}

function optimizeForRuntime(
  absPath: string,
  ext: string,
  rawBytes: Uint8Array<ArrayBuffer>,
  dims: { width: number, height: number },
  stem: string,
  hash: string,
  rawFileName: string,
  cacheRoot: string,
  pipelineCfg: VariantPipelineConfig,
  runtimeStore: RuntimeImageStore,
): ImageAsset {
  const rawMime = mimeForImageExt(ext)
  if (!hasMagick()) {
    runtimeStore.setStatic(`/img/${rawFileName}`, rawBytes, rawMime)
    return { src: `/img/${rawFileName}`, width: dims.width, height: dims.height }
  }
  const metaPath = join(cacheRoot, `md-${stem}-${hash}.json`)
  const cachedMeta = readCachedMeta(metaPath, cacheRoot, 'md-')
  if (cachedMeta !== undefined) {
    return assembleImageAsset(cachedMeta, cacheRoot, 'md-', '', (_rel, fileName, cachedFile) => {
      const mime = mimeForImageExt(extname(fileName))
      runtimeStore.setLazy(`/img/${fileName}`, async () => {
        try {
          const bytes = new Uint8Array(await Bun.file(cachedFile).arrayBuffer())
          return { body: bytes, contentType: mime, etag: computeEtag(bytes) }
        }
        catch {
          return { body: rawBytes, contentType: rawMime, etag: computeEtag(rawBytes) }
        }
      })
    })
  }
  const jobs = planVariantJobs(dims, stem, hash, cacheRoot, pipelineCfg)
  const plannedMeta: CachedImageMeta = {
    width: dims.width,
    height: dims.height,
    files: jobs.map(j => ({ rel: `img/${j.fileName}`, width: j.width, format: j.format })),
  }
  const jobByFile = new Map(jobs.map(j => [j.fileName, j]))
  return assembleImageAsset(plannedMeta, cacheRoot, 'md-', '', (_rel, fileName) => {
    const job = jobByFile.get(fileName)!
    const targetMime = mimeForImageExt(`.${job.format}`)
    runtimeStore.setLazy(`/img/${fileName}`, async () => {
      const encoded = await encodeVariantToBytesAsync(absPath, job.width, job.format, job.quality)
      if (encoded !== undefined)
        return { body: encoded, contentType: targetMime, etag: computeEtag(encoded) }
      return { body: rawBytes, contentType: rawMime, etag: computeEtag(rawBytes) }
    })
  })
}

/** Optimize a local image file (e.g. from Markdown) with non-blocking encoding and runtime in-memory serving for --compile. */
export function optimizeImageFile(absPath: string, options: OptimizeImageFileOptions = {}): ImageAsset {
  const ext = extname(absPath).toLowerCase()
  if (!ALLOWED_IMAGE_EXTS.has(ext))
    throw new Error(`@kayjs/images: unsupported image extension "${ext || '(none)'}" for "${absPath}"`)

  const pipelineCfg: VariantPipelineConfig = {
    widths: (options.widths ?? [640, 1280]).slice().sort((a, b) => a - b),
    formats: options.formats ?? ['webp'],
    quality: options.quality ?? 80,
    avifQuality: options.avifQuality ?? 55,
    cachePrefix: 'md-',
  }
  const appCtx = getAppContext()
  const rawBytes = new Uint8Array(readFileSync(absPath))
  const dims = readImageDimensions(rawBytes)
  if (dims === undefined)
    throw new Error(`@kayjs/images: could not determine dimensions for "${absPath}"`)

  const { hash, stem, rawFileName } = computeImageKey(absPath, rawBytes, pipelineCfg)
  const cacheRoot = resolve(options.cacheDir ?? '.kay-cache/images')
  const inBuild = appCtx !== undefined && isBuildPhase(appCtx.outDir)

  // Runtime server mode (including --compile): never write to dist/public or block on Bun.spawnSync.
  const runtimeStore = options.outPublicDir === undefined ? appCtx?.inject(RUNTIME_IMAGE_STORE_SERVICE) : undefined
  if (runtimeStore !== undefined && !inBuild)
    return optimizeForRuntime(absPath, ext, rawBytes, dims, stem, hash, rawFileName, cacheRoot, pipelineCfg, runtimeStore)

  const outPublicDir = resolve(options.outPublicDir ?? appCtx?.publicDir ?? 'dist/public')
  const imgOutDir = join(outPublicDir, 'img')
  mkdirSync(imgOutDir, { recursive: true })
  const emitRaw = (): ImageAsset => {
    writeFileSync(join(imgOutDir, rawFileName), rawBytes)
    appCtx?.registerPublicFile(`img/${rawFileName}`)
    return { src: `/img/${rawFileName}`, width: dims.width, height: dims.height }
  }

  if (!hasMagick())
    return emitRaw()

  const metaPath = join(cacheRoot, `md-${stem}-${hash}.json`)
  const cachedMeta = readCachedMeta(metaPath, cacheRoot, 'md-')
  if (cachedMeta !== undefined) {
    return assembleImageAsset(cachedMeta, cacheRoot, 'md-', '', (_rel, fileName, cachedFile) => {
      writeFileSync(join(imgOutDir, fileName), readFileSync(cachedFile))
      appCtx?.registerPublicFile(`img/${fileName}`)
    })
  }

  if (!inBuild)
    return emitRaw()

  // Build / prerender mode: queue non-blocking async Bun.spawn encoding and flush in afterPrerender().
  const jobs = planVariantJobs(dims, stem, hash, cacheRoot, pipelineCfg)
  const plannedMeta: CachedImageMeta = {
    width: dims.width,
    height: dims.height,
    files: jobs.map(j => ({ rel: `img/${j.fileName}`, width: j.width, format: j.format })),
  }
  queueBuildTask(appCtx.outDir, (async () => {
    mkdirSync(cacheRoot, { recursive: true })
    mkdirSync(imgOutDir, { recursive: true })
    const encoded = await mapConcurrent(jobs, MAX_ENCODE_CONCURRENCY, async (job) => {
      const ok = existsSync(job.cachedFile) || await encodeVariantAsync(absPath, job.cachedFile, job.width, job.quality)
      if (!ok)
        return undefined
      writeFileSync(join(imgOutDir, job.fileName), readFileSync(job.cachedFile))
      return { rel: `img/${job.fileName}`, width: job.width, format: job.format }
    })
    const files = encoded.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    if (files.length === jobs.length)
      writeFileAtomic(metaPath, JSON.stringify({ width: dims.width, height: dims.height, files }))
  })())
  return assembleImageAsset(plannedMeta, cacheRoot, 'md-', '', (_rel, fileName) => {
    appCtx.registerPublicFile(`img/${fileName}`)
  })
}

export interface MarkdownImageResolverOptions extends OptimizeImageFileOptions {
  sizes?: string | undefined
  /** Project root boundary confining resolved relative Markdown image paths. */
  root?: string | undefined
}

/** Creates a `@kayjs/content` `resolveImage` function backed by `optimizeImageFile()`. Automatically wired by `images()`. */
export function createMarkdownImageResolver(options: MarkdownImageResolverOptions = {}) {
  const sizes = options.sizes ?? '(min-width: 48rem) 42rem, 100vw'
  return (src: string, file: string | undefined) => {
    if (!file || !src.startsWith('.'))
      return undefined
    const absFile = resolve(file)
    let boundary: string
    if (options.root !== undefined) {
      boundary = resolve(options.root)
    }
    else {
      const kayRoot = getAppContext()?.root
      boundary = (typeof kayRoot === 'string' && kayRoot !== '' && isInside(resolve(kayRoot), absFile))
        ? resolve(kayRoot)
        : dirname(absFile)
    }

    const abs = resolve(dirname(absFile), src)
    if (!isInside(boundary, abs))
      return undefined
    if (!ALLOWED_IMAGE_EXTS.has(extname(abs).toLowerCase()))
      return undefined
    if (!existsSync(abs))
      return undefined

    let realBoundary: string
    let realTarget: string
    try {
      realBoundary = realpathSync(boundary)
      realTarget = realpathSync(abs)
    }
    catch {
      return undefined
    }
    if (!isInside(realBoundary, realTarget))
      return undefined
    if (!ALLOWED_IMAGE_EXTS.has(extname(realTarget).toLowerCase()))
      return undefined

    const asset = optimizeImageFile(realTarget, options)
    const srcset = asset.webpSrcset ?? asset.avifSrcset
    return {
      src: asset.src,
      ...(srcset !== undefined ? { srcset } : {}),
      ...(asset.avifSrcset !== undefined && asset.webpSrcset !== undefined ? { avifSrcset: asset.avifSrcset } : {}),
      ...(srcset !== undefined ? { sizes } : {}),
      width: asset.width,
      height: asset.height,
      loading: 'lazy' as const,
    }
  }
}
