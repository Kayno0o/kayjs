// @kayjs/images — Build-time AVIF/WebP responsive image optimization with content-hashed disk cache.
// Built strictly on the public KayPlugin API (bunPlugins + build(ctx).emitAsset).

import type { BunPlugin } from 'bun'
import type { KayPlugin } from 'kay/server'
import type { ShareCardDefaults } from './card'
import type { ImageAsset } from './helpers'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { configureShareCard } from './card'

const IMAGE_RESOLVERS_KEY = Symbol.for('kay.content.imageResolvers')
const KAY_ROOT_KEY = Symbol.for('kay.root')

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

function isInsideDir(dir: string, target: string): boolean {
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

function hasMagick(): boolean {
  return Bun.which('magick') !== null
}

function identifyImage(filePath: string): { width: number, height: number } | undefined {
  const proc = Bun.spawnSync(['magick', 'identify', '-ping', '-format', '%w %h', `${filePath}[0]`], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0)
    return undefined
  const parts = proc.stdout.toString().trim().split(/\s+/)
  const w = Number(parts[0])
  const h = Number(parts[1])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
    return undefined
  return { width: w, height: h }
}

function encodeVariant(srcPath: string, dstPath: string, width: number, quality: number): boolean {
  const proc = Bun.spawnSync(
    ['magick', `${srcPath}[0]`, '-auto-orient', '-strip', '-resize', `${width}x>`, '-quality', String(quality), dstPath],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  return proc.exitCode === 0 && existsSync(dstPath)
}

export function images(options: ImagesPluginOptions = {}): KayPlugin {
  const widths = (options.widths ?? DEFAULT_WIDTHS).slice().sort((a, b) => a - b)
  const formats = options.formats ?? DEFAULT_FORMATS
  const quality = options.quality ?? 80
  const avifQuality = options.avifQuality ?? 55
  const cacheDirRel = options.cacheDir ?? '.kay-cache/images'
  const pruneCache = options.pruneCache ?? true
  const magickAvailable = hasMagick()

  const emittedAssets = new Map<string, Uint8Array>()
  const activeCacheFiles = new Set<string>()
  let lastCacheRoot: string | undefined

  return {
    name: '@kayjs/images',
    bunPlugins: ({ root, assetPrefix }): BunPlugin[] => {
      const cacheRoot = resolve(root, cacheDirRel)
      lastCacheRoot = cacheRoot
      const prefix = assetPrefix.replace(/\/$/, '')

      return [{
        name: 'kayjs-images',
        setup(b) {
          b.onLoad({ filter: /\.(?:png|jpe?g|webp|avif)$/i }, (args) => {
            if (args.path.includes('/node_modules/'))
              return undefined

            const rawBytes = new Uint8Array(readFileSync(args.path))
            const hash = Bun.hash(`${Bun.hash(rawBytes)}:${widths.join(',')}:${formats.join(',')}:${quality}:${avifQuality}`).toString(36)
            const stem = basename(args.path, extname(args.path)).toLowerCase().replace(/[^a-z0-9-_]/g, '-')

            if (!magickAvailable) {
              const rel = `img/${stem}-${hash}${extname(args.path).toLowerCase()}`
              emittedAssets.set(rel, rawBytes)
              const asset: ImageAsset = { src: `${prefix}/${rel}`, width: 0, height: 0 }
              return { contents: `export default ${JSON.stringify(asset)};\n`, loader: 'js' }
            }

            mkdirSync(cacheRoot, { recursive: true })
            const metaName = `${stem}-${hash}.json`
            const metaPath = join(cacheRoot, metaName)
            activeCacheFiles.add(metaName)
            let meta: CachedImageMeta | undefined

            if (existsSync(metaPath)) {
              try {
                const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as CachedImageMeta
                if (parsed.files.every(f => existsSync(join(cacheRoot, basename(f.rel)))))
                  meta = parsed
              }
              catch {
                meta = undefined
              }
            }

            if (meta === undefined) {
              const dims = identifyImage(args.path)
              if (dims === undefined) {
                const rel = `img/${stem}-${hash}${extname(args.path).toLowerCase()}`
                emittedAssets.set(rel, rawBytes)
                const asset: ImageAsset = { src: `${prefix}/${rel}`, width: 0, height: 0 }
                return { contents: `export default ${JSON.stringify(asset)};\n`, loader: 'js' }
              }

              const targetWidths = widths.filter(w => w < dims.width)
              targetWidths.push(dims.width)
              const files: CachedImageMeta['files'] = []

              for (const w of targetWidths) {
                for (const fmt of formats) {
                  const fileName = `${stem}-${hash}-${w}w.${fmt}`
                  const cachedFile = join(cacheRoot, fileName)
                  const q = fmt === 'avif' ? avifQuality : quality
                  if (existsSync(cachedFile) || encodeVariant(args.path, cachedFile, w, q))
                    files.push({ rel: `img/${fileName}`, width: w, format: fmt })
                }
              }

              if (files.length === 0) {
                const rel = `img/${stem}-${hash}${extname(args.path).toLowerCase()}`
                emittedAssets.set(rel, rawBytes)
                const asset: ImageAsset = { src: `${prefix}/${rel}`, width: dims.width, height: dims.height }
                return { contents: `export default ${JSON.stringify(asset)};\n`, loader: 'js' }
              }

              meta = { width: dims.width, height: dims.height, files }
              writeFileSync(metaPath, JSON.stringify(meta))
            }

            const webpEntries: string[] = []
            const avifEntries: string[] = []
            let fallbackSrc = ''

            for (const f of meta.files) {
              const cacheFileName = basename(f.rel)
              activeCacheFiles.add(cacheFileName)
              const cachedFile = join(cacheRoot, cacheFileName)
              if (!emittedAssets.has(f.rel))
                emittedAssets.set(f.rel, new Uint8Array(readFileSync(cachedFile)))
              const url = `${prefix}/${f.rel}`
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

            const asset: ImageAsset = {
              src: fallbackSrc,
              width: meta.width,
              height: meta.height,
              ...(webpEntries.length > 0 ? { webpSrcset: webpEntries.join(', ') } : {}),
              ...(avifEntries.length > 0 ? { avifSrcset: avifEntries.join(', ') } : {}),
            }

            return { contents: `export default ${JSON.stringify(asset)};\n`, loader: 'js' }
          })
        },
      }]
    },
    build(ctx) {
      const publicDir = join(ctx.outDir, 'public')
      const cacheDir = resolve(ctx.root, cacheDirRel)
      configureShareCard({
        ...options.card,
        publicDir,
        cacheDir,
      })
      const g = globalThis as Record<symbol, Map<string, ReturnType<typeof createMarkdownImageResolver>> | undefined>
      const registry = g[IMAGE_RESOLVERS_KEY] ??= new Map()
      registry.set(resolve(ctx.root), createMarkdownImageResolver({
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
  }
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

  const widths = (options.widths ?? [640, 1280]).slice().sort((a, b) => a - b)
  const formats = options.formats ?? ['webp']
  const quality = options.quality ?? 80
  const avifQuality = options.avifQuality ?? 55
  const outPublicDir = resolve(options.outPublicDir ?? 'dist/public')
  const imgOutDir = join(outPublicDir, 'img')
  mkdirSync(imgOutDir, { recursive: true })

  const rawBytes = new Uint8Array(readFileSync(absPath))
  const hash = Bun.hash(`${Bun.hash(rawBytes)}:${widths.join(',')}:${formats.join(',')}:${quality}:${avifQuality}`).toString(36)
  const stem = basename(absPath, extname(absPath)).toLowerCase().replace(/[^a-z0-9-_]/g, '-')

  if (!hasMagick()) {
    const fileName = `${stem}-${hash}${extname(absPath).toLowerCase()}`
    writeFileSync(join(imgOutDir, fileName), rawBytes)
    return { src: `/img/${fileName}`, width: 0, height: 0 }
  }

  const cacheRoot = resolve(options.cacheDir ?? '.kay-cache/images')
  mkdirSync(cacheRoot, { recursive: true })
  const metaPath = join(cacheRoot, `md-${stem}-${hash}.json`)
  let meta: CachedImageMeta | undefined

  if (existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as CachedImageMeta
      if (parsed.files.every(f => existsSync(join(cacheRoot, `md-${basename(f.rel)}`))))
        meta = parsed
    }
    catch {
      meta = undefined
    }
  }

  if (meta === undefined) {
    const dims = identifyImage(absPath)
    if (dims === undefined) {
      const fileName = `${stem}-${hash}${extname(absPath).toLowerCase()}`
      writeFileSync(join(imgOutDir, fileName), rawBytes)
      return { src: `/img/${fileName}`, width: 0, height: 0 }
    }

    const targetWidths = widths.filter(w => w < dims.width)
    targetWidths.push(dims.width)
    const files: CachedImageMeta['files'] = []

    for (const w of targetWidths) {
      for (const fmt of formats) {
        const fileName = `${stem}-${hash}-${w}w.${fmt}`
        const cachedFile = join(cacheRoot, `md-${fileName}`)
        const q = fmt === 'avif' ? avifQuality : quality
        if (existsSync(cachedFile) || encodeVariant(absPath, cachedFile, w, q))
          files.push({ rel: `img/${fileName}`, width: w, format: fmt })
      }
    }

    if (files.length === 0) {
      const fileName = `${stem}-${hash}${extname(absPath).toLowerCase()}`
      writeFileSync(join(imgOutDir, fileName), rawBytes)
      return { src: `/img/${fileName}`, width: dims.width, height: dims.height }
    }

    meta = { width: dims.width, height: dims.height, files }
    writeFileSync(metaPath, JSON.stringify(meta))
  }

  const webpEntries: string[] = []
  const avifEntries: string[] = []
  let fallbackSrc = ''

  for (const f of meta.files) {
    const fileName = basename(f.rel)
    const cachedFile = join(cacheRoot, `md-${fileName}`)
    writeFileSync(join(imgOutDir, fileName), readFileSync(cachedFile))
    const url = `/img/${fileName}`
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
      const kayRoot = (globalThis as Record<symbol, unknown>)[KAY_ROOT_KEY]
      boundary = (typeof kayRoot === 'string' && kayRoot !== '' && isInsideDir(resolve(kayRoot), absFile))
        ? resolve(kayRoot)
        : dirname(absFile)
    }

    const abs = resolve(dirname(absFile), src)
    if (!isInsideDir(boundary, abs))
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
    if (!isInsideDir(realBoundary, realTarget))
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
