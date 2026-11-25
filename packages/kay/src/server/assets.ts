// Files served as they are: hashed build assets, public files and prerendered pages, with their headers fixed at startup.

import type { RouteManifestEntry } from '../build/index'
import type { CompressionCache } from './compress'
import type { EmbeddedBody } from './http'
import { existsSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { isCompressibleType, pickEncoding, pickPrecompressedEncoding, toWeakEtag } from './compress'
import { etagMatches, MIME } from './http'

const textEncoder = new TextEncoder()

// A build file ready to serve: headers and compression key are fixed at startup, so a request only picks a variant.
export interface ServedFile {
  key: string
  headers: Record<string, string>
  /** Headers of the on-the-fly compressed variant; undefined when the file is never compressed here. */
  compressedHeaders: Record<string, string> | undefined
  body: BodyInit
  read: () => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>
}

interface Sidecar {
  body: BodyInit
  headers: Record<string, string>
}

export interface AssetEntry {
  file: ServedFile
  br: Sidecar | undefined
  gz: Sidecar | undefined
}

export interface PublicEntry {
  file: ServedFile
  etag: string
  notModifiedHeaders: Record<string, string>
}

export interface AssetsOptions {
  assets: Record<string, EmbeddedBody>
  assetPrefix: string
  isDev: boolean
  compressEnabled: boolean
  compressCache: CompressionCache | undefined
  nosniffHeader: Record<string, string>
  withHsts: (res: Response, request: Request) => Response
}

export interface PrerenderedSources {
  prerendered: Record<string, string>
  prerenderedFiles: Record<string, string>
  /** HTML headers of a prerendered page, before the `Vary` header compression adds. */
  htmlHeaders: (route: RouteManifestEntry, urlPath: string) => Record<string, string>
  /** Whether a prerendered URL may be answered before any middleware, rewrite or plugin route. */
  isFast: (urlPath: string, route: RouteManifestEntry) => boolean
}

export function createAssets(options: AssetsOptions) {
  const { assets, assetPrefix, isDev, compressEnabled, compressCache, nosniffHeader, withHsts } = options
  const varyEncoding: Record<string, string> = compressCache !== undefined ? { vary: 'Accept-Encoding' } : {}

  const toBody = (body: EmbeddedBody): BodyInit => typeof body === 'string' ? Bun.file(body) : body
  const readBody = async (body: EmbeddedBody): Promise<Uint8Array<ArrayBuffer>> => typeof body === 'string' ? new Uint8Array(await Bun.file(body).arrayBuffer()) : body
  const builtFile = (key: string, source: EmbeddedBody, headers: Record<string, string>, compressedHeaders: Record<string, string> | undefined): ServedFile =>
    ({ key, headers, compressedHeaders, body: toBody(source), read: () => readBody(source) })

  const publicMap = new Map<string, PublicEntry>()
  const publicCacheControl = isDev ? 'no-cache' : 'public, max-age=3600'

  const registerPublic = (rel: string, body: EmbeddedBody, explicitEtag?: string): void => {
    const cleanRel = rel.replace(/^\/+/, '')
    const etag = explicitEtag ?? `W/"${Bun.hash(typeof body === 'string' ? cleanRel : body).toString(36)}"`
    const type = MIME[extname(cleanRel).toLowerCase()] ?? 'application/octet-stream'
    const hasVary = compressCache !== undefined && isCompressibleType(type)
    const validators = { etag, 'cache-control': publicCacheControl, ...(hasVary ? { vary: 'Accept-Encoding' } : {}), ...nosniffHeader }
    const headers = { 'content-type': type, ...validators }
    publicMap.set(`/${cleanRel}`, {
      etag,
      notModifiedHeaders: validators,
      file: builtFile(`p:/${cleanRel}:${etag}`, body, headers, hasVary ? { ...headers, etag: toWeakEtag(etag) } : undefined),
    })
  }

  // A file a plugin writes into the public dir at runtime, served once it exists on disk.
  const registerPublicFromDisk = (publicDir: string, rel: string): void => {
    const cleanRel = rel.replace(/^\/+/, '')
    const abs = join(publicDir, cleanRel)
    if (existsSync(abs)) {
      const st = statSync(abs)
      registerPublic(cleanRel, abs, `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`)
    }
  }

  // Hashed build assets: immutable cache, precompressed .br/.gz sidecars, optional lazy compression.
  // Skip `.br`/`.gz` sidecars as standalone HTTP routes when their base asset exists.
  const assetMap = new Map<string, AssetEntry>()
  for (const [rel, body] of Object.entries(assets)) {
    if ((rel.endsWith('.br') || rel.endsWith('.gz')) && rel.slice(0, -3) in assets)
      continue
    const type = MIME[extname(rel).toLowerCase()] ?? 'application/octet-stream'
    const compressible = compressCache !== undefined && isCompressibleType(type)
    const headers: Record<string, string> = {
      'content-type': type,
      'cache-control': 'public, max-age=31536000, immutable',
      ...nosniffHeader,
    }
    const sidecar = (ext: 'br' | 'gz', encoding: string): Sidecar | undefined => {
      const source = assets[`${rel}.${ext}`] ?? (typeof body === 'string' && existsSync(`${body}.${ext}`) ? `${body}.${ext}` : undefined)
      return source === undefined ? undefined : { body: toBody(source), headers: { ...headers, 'content-encoding': encoding, 'vary': 'Accept-Encoding' } }
    }
    const br = sidecar('br', 'br')
    const gz = sidecar('gz', 'gzip')
    const varyHeaders = compressible || br !== undefined || gz !== undefined ? { ...headers, vary: 'Accept-Encoding' } : headers
    assetMap.set(`${assetPrefix}/${rel}`, {
      file: builtFile(`a:${assetPrefix}/${rel}`, body, varyHeaders, compressible ? varyHeaders : undefined),
      br,
      gz,
    })
  }

  // Prerendered pages (zero-copy file paths preferred; raw HTML strings supported). `fast` holds those nothing may intercept.
  function collectPrerendered(routes: readonly RouteManifestEntry[], sources: PrerenderedSources): { all: Map<string, ServedFile>, fast: Map<string, ServedFile> } {
    const all = new Map<string, ServedFile>()
    const fast = new Map<string, ServedFile>()
    for (const route of routes) {
      if (route.prerendered === undefined)
        continue
      for (const [urlPath, relHtml] of Object.entries(route.prerendered)) {
        const headers: Record<string, string> = { ...sources.htmlHeaders(route, urlPath), ...varyEncoding }
        const compressedHeaders = compressCache !== undefined ? headers : undefined
        const filePath = sources.prerenderedFiles[relHtml]
        const html = sources.prerendered[relHtml]
        const key = `pre:${urlPath}`
        const entry: ServedFile | undefined = filePath !== undefined
          ? builtFile(key, filePath, headers, compressedHeaders)
          : html !== undefined
            ? { key, headers, compressedHeaders, body: html, read: () => textEncoder.encode(html) }
            : undefined
        if (entry === undefined)
          continue
        all.set(urlPath, entry)
        if (sources.isFast(urlPath, route))
          fast.set(urlPath, entry)
      }
    }
    return { all, fast }
  }

  async function serveFile(request: Request, file: ServedFile): Promise<Response> {
    if (request.method === 'HEAD')
      return withHsts(new Response(null, { status: 200, headers: file.headers }), request)
    if (file.compressedHeaders !== undefined && compressCache !== undefined) {
      const enc = pickEncoding(request.headers.get('accept-encoding'))
      if (enc !== undefined) {
        const compressed = await compressCache.file(file.key, enc, file.read)
        if (compressed !== undefined)
          return withHsts(new Response(compressed, { status: 200, headers: { ...file.compressedHeaders, 'content-encoding': enc } }), request)
      }
    }
    return withHsts(new Response(file.body, { status: 200, headers: file.headers }), request)
  }

  async function serveAsset(request: Request, asset: AssetEntry): Promise<Response> {
    if (compressEnabled && request.method !== 'HEAD' && (asset.br !== undefined || asset.gz !== undefined)) {
      const preEnc = pickPrecompressedEncoding(request.headers.get('accept-encoding'), { br: asset.br !== undefined, gz: asset.gz !== undefined })
      if (preEnc !== undefined) {
        const sidecar = preEnc === 'br' ? asset.br! : asset.gz!
        return withHsts(new Response(sidecar.body, { status: 200, headers: sidecar.headers }), request)
      }
    }
    return serveFile(request, asset.file)
  }

  async function servePublic(request: Request, pub: PublicEntry): Promise<Response> {
    if (etagMatches(request.headers.get('if-none-match'), pub.etag))
      return withHsts(new Response(null, { status: 304, headers: pub.notModifiedHeaders }), request)
    return serveFile(request, pub.file)
  }

  return { assetMap, publicMap, registerPublic, registerPublicFromDisk, collectPrerendered, serveFile, serveAsset, servePublic }
}
