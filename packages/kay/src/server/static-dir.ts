// Standalone `--static` directory server (used when `outDir` holds exported HTML without `manifest.json`).

import type { Stats } from 'node:fs'
import type { KayApp } from './http'
import type { SecurityHeadersOptions, TrustProxy } from './security'
import { existsSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { CompressionCache, isCompressibleType, maybeCompressResponse, pickPrecompressedEncoding, toWeakEtag } from './compress'
import { applyHstsHeader, etagMatches, MIME } from './http'
import { buildSecurityHeaderEntries, KAY_ISLAND_STYLE_HASH, resolveCspPolicy, resolveHstsValue, withCspHashes } from './security'

const isRead = (request: Request): boolean => request.method === 'GET' || request.method === 'HEAD'

export function createStaticDirServer(
  outDir: string,
  assetPrefix: string,
  security: SecurityHeadersOptions | false | undefined,
  compressEnabled: boolean,
  trustProxy: TrustProxy,
  isDev = false,
): KayApp {
  const cleanPrefix = `${assetPrefix.replace(/\/$/, '')}/`
  const absRoot = resolve(outDir)
  const compressCache = compressEnabled ? new CompressionCache() : undefined
  const securityEntries = buildSecurityHeaderEntries(security)
  const baseCsp = resolveCspPolicy(security)
  const htmlCsp = baseCsp !== undefined ? withCspHashes(baseCsp, { styleHashes: [KAY_ISLAND_STYLE_HASH] }) : undefined
  const htmlSecurityEntries: [string, string][] = securityEntries.map(([k, v]) =>
    k === 'content-security-policy' && htmlCsp !== undefined ? [k, htmlCsp] : [k, v],
  )
  const hstsValue = resolveHstsValue(security)
  const withHsts = (res: Response, req: Request) => applyHstsHeader(res, req, hstsValue, trustProxy, isDev)

  function statFile(abs: string): Stats | undefined {
    try {
      const st = statSync(abs, { throwIfNoEntry: false })
      return st?.isFile() ? st : undefined
    }
    catch {
      return undefined
    }
  }

  function resolveStaticFile(pathname: string): { path: string, st: Stats } | undefined {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    }
    catch {
      return undefined
    }
    if (decoded.includes('\0'))
      return undefined
    const rel = decoded.replace(/^\/+/, '').replace(/\/+$/, '')
    const candidates = rel === ''
      ? ['index.html']
      : [rel, `${rel}.html`, `${rel}/index.html`]
    for (const c of candidates) {
      const abs = resolve(absRoot, c)
      if (abs !== absRoot && !abs.startsWith(`${absRoot}/`) && !abs.startsWith(`${absRoot}\\`))
        continue
      const st = statFile(abs)
      if (st !== undefined)
        return { path: abs, st }
    }
    return undefined
  }

  const initHeaders = (isHtml = false): Headers => new Headers((isHtml ? htmlSecurityEntries : securityEntries) as [string, string][])

  const handle = async (req: Request): Promise<Response> => {
    if (!isRead(req)) {
      const headers = initHeaders()
      headers.set('allow', 'GET, HEAD')
      return withHsts(new Response('Method Not Allowed', { status: 405, headers }), req)
    }

    const url = new URL(req.url)
    const found = resolveStaticFile(url.pathname)
    if (found === undefined) {
      const notFoundPath = join(absRoot, '404.html')
      if (statFile(notFoundPath) !== undefined) {
        const headers = initHeaders(true)
        headers.set('content-type', 'text/html; charset=utf-8')
        return withHsts(new Response(req.method === 'HEAD' ? null : Bun.file(notFoundPath), { status: 404, headers }), req)
      }
      return withHsts(new Response('Not Found', { status: 404, headers: initHeaders() }), req)
    }

    const { path: filePath, st } = found
    const ext = extname(filePath).toLowerCase()
    const mime = MIME[ext] ?? 'application/octet-stream'
    const isHtml = ext === '.html' || ext === '.htm'
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
    const isImmutable = url.pathname.startsWith(cleanPrefix)
    const headers = initHeaders(isHtml)
    headers.set('content-type', mime)
    headers.set('cache-control', isImmutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate')
    headers.set('etag', etag)

    const hasBr = compressEnabled && existsSync(`${filePath}.br`)
    const hasGz = compressEnabled && existsSync(`${filePath}.gz`)
    if (hasBr || hasGz || (compressEnabled && isCompressibleType(mime)))
      headers.set('vary', 'Accept-Encoding')

    if (etagMatches(req.headers.get('if-none-match'), etag))
      return withHsts(new Response(null, { status: 304, headers }), req)

    if (compressEnabled && req.method !== 'HEAD' && (hasBr || hasGz)) {
      const preEnc = pickPrecompressedEncoding(req.headers.get('accept-encoding'), { br: hasBr, gz: hasGz })
      if (preEnc !== undefined) {
        headers.set('content-encoding', preEnc)
        headers.set('etag', toWeakEtag(etag))
        return withHsts(new Response(Bun.file(`${filePath}.${preEnc === 'br' ? 'br' : 'gz'}`), { status: 200, headers }), req)
      }
    }

    headers.set('content-length', String(st.size))
    const res = new Response(req.method === 'HEAD' ? null : Bun.file(filePath), { status: 200, headers })
    if (!compressEnabled || req.method === 'HEAD')
      return withHsts(res, req)
    return withHsts(await maybeCompressResponse(res, req, compressCache), req)
  }

  return {
    handle,
    serve(port = 3000, hostname = '127.0.0.1') {
      return Bun.serve({
        port,
        hostname,
        idleTimeout: 30,
        development: false,
        fetch: handle,
        error() {
          return new Response('Internal Server Error', {
            status: 500,
            headers: { 'content-type': 'text/plain; charset=utf-8', ...Object.fromEntries(securityEntries) },
          })
        },
      })
    },
    async dispose() {},
  }
}
