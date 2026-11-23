// @kayjs/images — Build-time AVIF/WebP responsive image optimization with content-hashed disk cache.
// Built strictly on the public KayPlugin API (bunPlugins + build(ctx).emitAsset).

import type { BunPlugin } from 'bun'
import type { KayPlugin } from 'kay/server'
import type { ImageAsset } from './helpers'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

export interface ImagesPluginOptions {
  widths?: number[] | undefined
  formats?: ('avif' | 'webp')[] | undefined
  quality?: number | undefined
  avifQuality?: number | undefined
  cacheDir?: string | undefined
  /** Remove stale cache files unused by the current build (default: true). */
  pruneCache?: boolean | undefined
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
      for (const [rel, bytes] of emittedAssets)
        ctx.emitAsset(rel, bytes)
      if (pruneCache && lastCacheRoot !== undefined && activeCacheFiles.size > 0 && existsSync(lastCacheRoot)) {
        for (const entry of readdirSync(lastCacheRoot)) {
          if (!activeCacheFiles.has(entry))
            rmSync(join(lastCacheRoot, entry), { force: true })
        }
      }
      emittedAssets.clear()
      activeCacheFiles.clear()
    },
  }
}
