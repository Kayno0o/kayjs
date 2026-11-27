// Files served as they are: hashed build assets, public files and prerendered pages, with their headers fixed at startup.

import type { RouteManifestEntry } from '../build/index'
import type { CompressionCache } from './compress'
import type { EmbeddedBody } from './http'
import type { FileSource, ServedFile } from './served-file'
import { existsSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { isCompressibleType } from './compress'
import { MIME } from './http'
import { createFileServer, servedFile } from './served-file'

export type { ServedFile } from './served-file'

export interface AssetsOptions {
  assets: Record<string, EmbeddedBody>
  assetPrefix: string
  isDev: boolean
  compressEnabled: boolean
  compressCache: CompressionCache | undefined
  nosniffHeader: Record<string, string>
  securityRecord: Record<string, string>
  withHsts: (res: Response, request: Request) => Response
}

export interface PrerenderedSources {
  prerendered: Record<string, string>
  prerenderedFiles: Record<string, string>
  /** ETags the build computed, by HTML file; a missing one comes from the file's size and mtime. */
  prerenderedEtags: Record<string, string>
  /** HTML headers of a prerendered page, before the `Vary` header compression adds. */
  htmlHeaders: (route: RouteManifestEntry, urlPath: string, relHtml: string) => Record<string, string>
  /** Whether a prerendered URL may be answered before any middleware, rewrite or plugin route. */
  isFast: (urlPath: string, route: RouteManifestEntry) => boolean
}

const embedded = (body: EmbeddedBody): FileSource => typeof body === 'string' ? { path: body } : { bytes: body }

export function createAssets(options: AssetsOptions) {
  const { assets, assetPrefix, isDev, compressEnabled, compressCache, nosniffHeader, securityRecord, withHsts } = options
  const serveFile = createFileServer({ compressEnabled, compressCache, withHsts })
  const compressible = (type: string): boolean => compressCache !== undefined && isCompressibleType(type)

  const publicMap = new Map<string, ServedFile>()
  const publicCacheControl = isDev ? 'no-cache' : 'public, max-age=3600'

  const registerPublic = (rel: string, body: EmbeddedBody, etag?: string): void => {
    const cleanRel = rel.replace(/^\/+/, '')
    const type = MIME[extname(cleanRel).toLowerCase()] ?? 'application/octet-stream'
    publicMap.set(`/${cleanRel}`, servedFile({
      key: `p:/${cleanRel}`,
      source: embedded(body),
      etag,
      headers: { 'content-type': type, 'cache-control': publicCacheControl, ...securityRecord },
      compressible: compressible(type),
    }))
  }

  // A file a plugin writes into the public dir at runtime, served once it exists on disk.
  const registerPublicFromDisk = (publicDir: string, rel: string): void => {
    const cleanRel = rel.replace(/^\/+/, '')
    const abs = join(publicDir, cleanRel)
    if (existsSync(abs) && statSync(abs).isFile())
      registerPublic(cleanRel, abs)
  }

  // Hashed build assets: immutable cache, precompressed .br/.gz sidecars, optional lazy compression.
  // Skip `.br`/`.gz` sidecars as standalone HTTP routes when their base asset exists.
  const assetMap = new Map<string, ServedFile>()
  for (const [rel, body] of Object.entries(assets)) {
    if ((rel.endsWith('.br') || rel.endsWith('.gz')) && rel.slice(0, -3) in assets)
      continue
    const type = MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream'
    const sidecar = (ext: 'br' | 'gz'): FileSource | undefined => {
      const source = assets[`${rel}.${ext}`] ?? (typeof body === 'string' && existsSync(`${body}.${ext}`) ? `${body}.${ext}` : undefined)
      return source === undefined ? undefined : embedded(source)
    }
    assetMap.set(`${assetPrefix}/${rel}`, servedFile({
      key: `a:${assetPrefix}/${rel}`,
      source: embedded(body),
      // The name holds the content hash, so it is the version.
      etag: `W/"${Bun.hash(rel).toString(36)}"`,
      headers: { 'content-type': type, 'cache-control': 'public, max-age=31536000, immutable', ...nosniffHeader },
      compressible: compressible(type),
      br: sidecar('br'),
      gz: sidecar('gz'),
    }))
  }

  // Prerendered pages (zero-copy file paths preferred; raw HTML strings supported). `fast` holds those nothing may intercept.
  function collectPrerendered(routes: readonly RouteManifestEntry[], sources: PrerenderedSources): { all: Map<string, ServedFile>, fast: Map<string, ServedFile> } {
    const all = new Map<string, ServedFile>()
    const fast = new Map<string, ServedFile>()
    for (const route of routes) {
      if (route.prerendered === undefined)
        continue
      for (const [urlPath, relHtml] of Object.entries(route.prerendered)) {
        const filePath = sources.prerenderedFiles[relHtml]
        const html = sources.prerendered[relHtml]
        const source: FileSource | undefined = filePath !== undefined ? { path: filePath } : html !== undefined ? { text: html } : undefined
        if (source === undefined)
          continue
        const entry = servedFile({
          key: `pre:${urlPath}`,
          source,
          etag: sources.prerenderedEtags[relHtml],
          headers: sources.htmlHeaders(route, urlPath, relHtml),
          compressible: compressCache !== undefined,
        })
        all.set(urlPath, entry)
        if (sources.isFast(urlPath, route))
          fast.set(urlPath, entry)
      }
    }
    return { all, fast }
  }

  return { assetMap, publicMap, registerPublic, registerPublicFromDisk, collectPrerendered, serveFile }
}
