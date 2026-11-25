// @kayjs/images — Build-time AVIF/WebP responsive image optimization with content-hashed disk cache.
// Built strictly on the public KayPlugin API (bunPlugins + build(ctx).emitAsset).

import type { BunPlugin } from 'bun'
import type { KayPlugin } from '@kayjs/kay/server'
import type { ShareCardDefaults } from './card'
import type { ImageAsset } from './helpers'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { CONTENT_IMAGE_RESOLVER_SERVICE, definePlugin, getAppContext } from '@kayjs/kay/server'
import { hasMagick, SHARE_CARD_CONFIG_SERVICE } from './card'

export { CONTENT_IMAGE_RESOLVER_SERVICE }

const ALLOWED_IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.avif',
  '.gif',
  '.svg',
  '.ico',
  '.bmp',
  '.tiff',
  '.tif',
])

function isStrictlyInside(dir: string, target: string): boolean {
  const rel = relative(dir, target)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

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

interface CachedImageMeta {
  width: number
  height: number
  files: { rel: string, width: number, format: string }[]
}

interface VariantEncodeJob {
  fileName: string
  cachedFile: string
  width: number
  format: 'avif' | 'webp'
  quality: number
}

interface VariantPipelineConfig {
  widths: number[]
  formats: ('avif' | 'webp')[]
  quality: number
  avifQuality: number
  cachePrefix: string
}

const MISSING_MAGICK_MESSAGE = '@kayjs/images: ImageMagick ("magick") was not found on PATH; AVIF/WebP optimization is disabled. Install ImageMagick to enable responsive image optimization.'
const MAX_ENCODE_CONCURRENCY = 4

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

function parseMagickDimensions(stdout: string): { width: number, height: number } | undefined {
  const parts = stdout.trim().split(/\s+/)
  const w = Number(parts[0])
  const h = Number(parts[1])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
    return undefined
  return { width: w, height: h }
}

function identifyImage(filePath: string): { width: number, height: number } | undefined {
  const proc = Bun.spawnSync(['magick', 'identify', '-ping', '-format', '%w %h', `${filePath}[0]`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0)
    return undefined
  return parseMagickDimensions(proc.stdout.toString())
}

async function identifyImageAsync(filePath: string): Promise<{ width: number, height: number } | undefined> {
  const proc = Bun.spawn(['magick', 'identify', '-ping', '-format', '%w %h', `${filePath}[0]`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
  if (exitCode !== 0)
    return undefined
  return parseMagickDimensions(stdout)
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx]!)
    }
  })
  await Promise.all(workers)
  return results
}

function writeFileAtomic(dstPath: string, data: string | Uint8Array): void {
  const tmpPath = `${dstPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmpPath, data)
  try {
    renameSync(tmpPath, dstPath)
  }
  catch {
    rmSync(tmpPath, { force: true })
  }
}

function variantTmpPath(dstPath: string): string {
  const ext = extname(dstPath)
  const stem = ext !== '' ? dstPath.slice(0, -ext.length) : dstPath
  return `${stem}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}${ext}`
}

function magickResizeArgs(srcPath: string, width: number, quality: number, tmpPath: string): string[] {
  return ['magick', `${srcPath}[0]`, '-auto-orient', '-strip', '-resize', `${width}x>`, '-quality', String(quality), tmpPath]
}

function finalizeEncodedVariant(exitCode: number, tmpPath: string, dstPath: string): boolean {
  if (exitCode === 0 && existsSync(tmpPath)) {
    try {
      renameSync(tmpPath, dstPath)
    }
    catch {
      rmSync(tmpPath, { force: true })
    }
    return existsSync(dstPath)
  }
  rmSync(tmpPath, { force: true })
  return false
}

function encodeVariant(srcPath: string, dstPath: string, width: number, quality: number): boolean {
  const tmpPath = variantTmpPath(dstPath)
  const proc = Bun.spawnSync(magickResizeArgs(srcPath, width, quality, tmpPath), { stdout: 'pipe', stderr: 'pipe' })
  return finalizeEncodedVariant(proc.exitCode, tmpPath, dstPath)
}

async function encodeVariantAsync(srcPath: string, dstPath: string, width: number, quality: number): Promise<boolean> {
  const tmpPath = variantTmpPath(dstPath)
  const proc = Bun.spawn(magickResizeArgs(srcPath, width, quality, tmpPath), { stdout: 'pipe', stderr: 'pipe' })
  return finalizeEncodedVariant(await proc.exited, tmpPath, dstPath)
}

function computeImageKey(srcPath: string, rawBytes: Uint8Array, cfg: VariantPipelineConfig): { hash: string, stem: string, rawFileName: string } {
  const ext = extname(srcPath).toLowerCase()
  const hash = Bun.hash(`${Bun.hash(rawBytes)}:${cfg.widths.join(',')}:${cfg.formats.join(',')}:${cfg.quality}:${cfg.avifQuality}`).toString(36)
  const stem = basename(srcPath, extname(srcPath)).toLowerCase().replace(/[^a-z0-9-_]/g, '-')
  return { hash, stem, rawFileName: `${stem}-${hash}${ext}` }
}

function readCachedMeta(metaPath: string, cacheRoot: string, cachePrefix: string): CachedImageMeta | undefined {
  if (!existsSync(metaPath))
    return undefined
  try {
    const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as CachedImageMeta
    if (parsed.files.every(f => existsSync(join(cacheRoot, `${cachePrefix}${basename(f.rel)}`))))
      return parsed
  }
  catch {
    return undefined
  }
  return undefined
}

function planVariantJobs(
  dims: { width: number, height: number },
  stem: string,
  hash: string,
  cacheRoot: string,
  cfg: VariantPipelineConfig,
): VariantEncodeJob[] {
  const targetWidths = cfg.widths.filter(w => w < dims.width)
  targetWidths.push(dims.width)
  const jobs: VariantEncodeJob[] = []
  for (const w of targetWidths) {
    for (const fmt of cfg.formats) {
      const fileName = `${stem}-${hash}-${w}w.${fmt}`
      jobs.push({
        fileName,
        cachedFile: join(cacheRoot, `${cfg.cachePrefix}${fileName}`),
        width: w,
        format: fmt,
        quality: fmt === 'avif' ? cfg.avifQuality : cfg.quality,
      })
    }
  }
  return jobs
}

function assembleImageAsset(
  meta: CachedImageMeta,
  cacheRoot: string,
  cachePrefix: string,
  urlPrefix: string,
  emitVariant: (rel: string, fileName: string, cachedFile: string) => void,
): ImageAsset {
  const webpEntries: string[] = []
  const avifEntries: string[] = []
  let fallbackSrc = ''

  for (const f of meta.files) {
    const fileName = basename(f.rel)
    const cachedFile = join(cacheRoot, `${cachePrefix}${fileName}`)
    emitVariant(f.rel, fileName, cachedFile)
    const url = `${urlPrefix}/${f.rel}`
    if (f.format === 'webp') {
      webpEntries.push(`${url} ${f.width}w`)
      fallbackSrc = url
    }
    else if (f.format === 'avif') {
      avifEntries.push(`${url} ${f.width}w`)
      if (fallbackSrc === '')
        fallbackSrc = url
    }
  }

  return {
    src: fallbackSrc,
    width: meta.width,
    height: meta.height,
    ...(webpEntries.length > 0 ? { webpSrcset: webpEntries.join(', ') } : {}),
    ...(avifEntries.length > 0 ? { avifSrcset: avifEntries.join(', ') } : {}),
  }
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
      ctx.provide(SHARE_CARD_CONFIG_SERVICE, {
        ...cardWithSite,
        publicDir,
        cacheDir,
      } satisfies ShareCardDefaults)
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
      if (pruneCache && lastCacheRoot !== undefined && activeCacheFiles.size > 0 && existsSync(lastCacheRoot)) {
        for (const entry of readdirSync(lastCacheRoot)) {
          if (entry.startsWith('og-') || entry.startsWith('md-'))
            continue
          if (!activeCacheFiles.has(entry))
            rmSync(join(lastCacheRoot, entry), { force: true })
        }
      }
      emittedAssets.clear()
      activeCacheFiles.clear()
    },
    server(api) {
      const persisted = api.getBuildData<PersistedImagesConfig>()
      const effCacheRel = persisted?.cacheDirRel ?? cacheDirRel
      const effWidths = persisted?.widths ?? widths
      const effFormats = persisted?.formats ?? formats
      const effQuality = persisted?.quality ?? quality
      const effAvifQuality = persisted?.avifQuality ?? avifQuality
      const effMarkdownSizes = persisted?.markdownSizes ?? options.markdownSizes
      const effCard = persisted?.card ?? options.card
      const publicDir = join(api.outDir, 'public')
      const cacheDir = resolve(api.root, effCacheRel)

      api.provide(SHARE_CARD_CONFIG_SERVICE, {
        ...(api.site !== undefined ? { site: api.site } : {}),
        ...effCard,
        publicDir,
        cacheDir,
      } satisfies ShareCardDefaults)
      api.provide(CONTENT_IMAGE_RESOLVER_SERVICE, createMarkdownImageResolver({
        root: resolve(api.root),
        outPublicDir: publicDir,
        cacheDir,
        widths: effWidths,
        formats: effFormats,
        quality: effQuality,
        avifQuality: effAvifQuality,
        sizes: effMarkdownSizes,
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

/** Synchronously optimize a local image file (e.g. from Markdown) into `dist/public/img/` with disk caching. */
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
  const outPublicDir = resolve(options.outPublicDir ?? appCtx?.publicDir ?? 'dist/public')
  const imgOutDir = join(outPublicDir, 'img')
  mkdirSync(imgOutDir, { recursive: true })

  const rawBytes = new Uint8Array(readFileSync(absPath))
  const { hash, stem, rawFileName } = computeImageKey(absPath, rawBytes, pipelineCfg)
  const emitRaw = (width: number, height: number): ImageAsset => {
    writeFileSync(join(imgOutDir, rawFileName), rawBytes)
    appCtx?.registerPublicFile(`img/${rawFileName}`)
    return { src: `/img/${rawFileName}`, width, height }
  }

  if (!hasMagick()) {
    const dims = readImageDimensions(rawBytes)
    if (dims === undefined)
      throw new Error(`@kayjs/images: could not determine dimensions for "${absPath}" (ImageMagick is unavailable and binary header could not be parsed)`)
    return emitRaw(dims.width, dims.height)
  }

  const cacheRoot = resolve(options.cacheDir ?? '.kay-cache/images')
  mkdirSync(cacheRoot, { recursive: true })
  const metaPath = join(cacheRoot, `md-${stem}-${hash}.json`)
  let meta = readCachedMeta(metaPath, cacheRoot, 'md-')

  if (meta === undefined) {
    const dims = identifyImage(absPath) ?? readImageDimensions(rawBytes)
    if (dims === undefined)
      throw new Error(`@kayjs/images: could not determine dimensions for "${absPath}"`)

    const jobs = planVariantJobs(dims, stem, hash, cacheRoot, pipelineCfg)
    const files: CachedImageMeta['files'] = []
    for (const job of jobs) {
      if (existsSync(job.cachedFile) || encodeVariant(absPath, job.cachedFile, job.width, job.quality))
        files.push({ rel: `img/${job.fileName}`, width: job.width, format: job.format })
    }
    if (files.length === 0)
      return emitRaw(dims.width, dims.height)

    meta = { width: dims.width, height: dims.height, files }
    writeFileAtomic(metaPath, JSON.stringify(meta))
  }

  return assembleImageAsset(meta, cacheRoot, 'md-', '', (_rel, fileName, cachedFile) => {
    writeFileSync(join(imgOutDir, fileName), readFileSync(cachedFile))
    appCtx?.registerPublicFile(`img/${fileName}`)
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
      boundary = (typeof kayRoot === 'string' && kayRoot !== '' && isStrictlyInside(resolve(kayRoot), absFile))
        ? resolve(kayRoot)
        : dirname(absFile)
    }

    const abs = resolve(dirname(absFile), src)
    if (!isStrictlyInside(boundary, abs))
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
    if (!isStrictlyInside(realBoundary, realTarget))
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
