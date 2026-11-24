// Zero-dependency native HTTP compression (Bun.zstdCompressSync / Bun.gzipSync) with bounded byte-budget LRU.
// Never imports `node:zlib` so server RSS stays minimal.

export type CompressionEncoding = 'zstd' | 'gzip'

export const MIN_COMPRESS_BYTES = 256
const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024
const encoder = new TextEncoder()

const COMPRESSIBLE_EXACT = new Set([
  'application/javascript',
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/manifest+json',
  'application/rss+xml',
  'application/atom+xml',
  'application/wasm',
  'image/svg+xml',
])

export function isCompressibleType(contentType: string | null | undefined): boolean {
  if (!contentType)
    return false
  const semi = contentType.indexOf(';')
  const mime = (semi === -1 ? contentType : contentType.slice(0, semi)).trim().toLowerCase()
  if (mime.startsWith('text/'))
    return mime !== 'text/event-stream'
  if (COMPRESSIBLE_EXACT.has(mime))
    return true
  return mime.endsWith('+json') || mime.endsWith('+xml')
}

export function pickEncoding(acceptEncoding: string | null): CompressionEncoding | undefined {
  if (!acceptEncoding)
    return undefined

  // Fast path: standard browser headers without q-values (e.g. "gzip, deflate, br, zstd")
  if (!acceptEncoding.includes(';')) {
    const lower = acceptEncoding.toLowerCase()
    if (hasToken(lower, 'zstd'))
      return 'zstd'
    if (hasToken(lower, 'gzip'))
      return 'gzip'
    return undefined
  }

  let zstdQ = -1
  let gzipQ = -1
  const parts = acceptEncoding.split(',')
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!.trim()
    if (!part)
      continue
    const semi = part.indexOf(';')
    const name = (semi === -1 ? part : part.slice(0, semi)).trim().toLowerCase()
    if (name !== 'zstd' && name !== 'gzip')
      continue
    let q = 1
    if (semi !== -1) {
      const m = /;\s*q\s*=\s*([0-9.]+)/i.exec(part.slice(semi))
      if (m !== null) {
        const parsed = Number(m[1])
        if (!Number.isNaN(parsed))
          q = parsed
      }
    }
    if (name === 'zstd')
      zstdQ = q
    else
      gzipQ = q
  }

  if (zstdQ <= 0 && gzipQ <= 0)
    return undefined
  return zstdQ >= gzipQ ? 'zstd' : 'gzip'
}

function hasToken(haystack: string, token: string): boolean {
  let idx = haystack.indexOf(token)
  while (idx !== -1) {
    const before = idx === 0 ? ',' : haystack[idx - 1]!
    const after = idx + token.length === haystack.length ? ',' : haystack[idx + token.length]!
    if ((before === ',' || before === ' ' || before === '\t') && (after === ',' || after === ' ' || after === '\t'))
      return true
    idx = haystack.indexOf(token, idx + token.length)
  }
  return false
}

export function compressBuffer(bytes: Uint8Array<ArrayBuffer>, encoding: CompressionEncoding): Uint8Array<ArrayBuffer> {
  if (encoding === 'zstd')
    return Bun.zstdCompressSync(bytes, { level: 3 }) as Uint8Array<ArrayBuffer>
  return Bun.gzipSync(bytes, { level: 6 }) as Uint8Array<ArrayBuffer>
}

export class CompressionCache {
  readonly #map = new Map<string, Uint8Array<ArrayBuffer>>()
  readonly #maxBytes: number
  readonly #maxEntryBytes: number
  #totalBytes = 0

  constructor(maxBytes = DEFAULT_MAX_CACHE_BYTES) {
    this.#maxBytes = maxBytes
    this.#maxEntryBytes = Math.floor(maxBytes / 4)
  }

  get(key: string): Uint8Array<ArrayBuffer> | undefined {
    const hit = this.#map.get(key)
    if (hit === undefined)
      return undefined
    // Refresh recency
    this.#map.delete(key)
    this.#map.set(key, hit)
    return hit
  }

  set(key: string, value: Uint8Array<ArrayBuffer>): void {
    const size = value.byteLength
    if (size > this.#maxEntryBytes)
      return
    const prev = this.#map.get(key)
    if (prev !== undefined) {
      this.#totalBytes -= prev.byteLength
      this.#map.delete(key)
    }
    this.#map.set(key, value)
    this.#totalBytes += size
    while (this.#totalBytes > this.#maxBytes) {
      const oldest = this.#map.keys().next()
      if (oldest.done)
        break
      const evicted = this.#map.get(oldest.value)!
      this.#map.delete(oldest.value)
      this.#totalBytes -= evicted.byteLength
    }
  }

  compress(bytes: Uint8Array<ArrayBuffer>, encoding: CompressionEncoding, staticKey?: string): Uint8Array<ArrayBuffer> | undefined {
    if (bytes.byteLength < MIN_COMPRESS_BYTES)
      return undefined
    const cacheKey = staticKey !== undefined
      ? `${encoding}:${staticKey}`
      : `${encoding}:h:${Bun.hash.wyhash(bytes).toString(36)}:${bytes.byteLength}`
    const cached = this.get(cacheKey)
    if (cached !== undefined)
      return cached
    const compressed = compressBuffer(bytes, encoding)
    if (compressed.byteLength >= bytes.byteLength)
      return undefined
    this.set(cacheKey, compressed)
    return compressed
  }
}

export function appendVaryAcceptEncoding(headers: Headers): void {
  const existing = headers.get('vary')
  if (!existing) {
    headers.set('vary', 'Accept-Encoding')
  }
  else if (!existing.toLowerCase().includes('accept-encoding')) {
    headers.set('vary', `${existing}, Accept-Encoding`)
  }
}

export function compressedHtmlResponse(
  html: string,
  status: number,
  baseHeaders: Record<string, string>,
  request: Request,
  cache: CompressionCache | undefined,
): Response {
  if (cache !== undefined && request.method !== 'HEAD') {
    const enc = pickEncoding(request.headers.get('accept-encoding'))
    if (enc !== undefined && html.length >= MIN_COMPRESS_BYTES) {
      const staticKey = `s:${Bun.hash.wyhash(html).toString(36)}:${html.length}`
      let compressed = cache.get(`${enc}:${staticKey}`)
      if (compressed === undefined) {
        const bytes = encoder.encode(html)
        compressed = cache.compress(bytes, enc, staticKey)
      }
      if (compressed !== undefined) {
        return new Response(compressed, {
          status,
          headers: { ...baseHeaders, 'content-encoding': enc, 'vary': 'Accept-Encoding' },
        })
      }
    }
  }
  return new Response(request.method === 'HEAD' ? null : html, {
    status,
    headers: cache !== undefined ? { ...baseHeaders, vary: 'Accept-Encoding' } : baseHeaders,
  })
}

export async function maybeCompressResponse(
  res: Response,
  request: Request,
  cache: CompressionCache | undefined,
): Promise<Response> {
  if (cache === undefined)
    return res
  if (res.status === 204 || res.status === 304 || (res.status >= 300 && res.status < 400))
    return res
  if (res.headers.has('content-encoding'))
    return res
  if (!isCompressibleType(res.headers.get('content-type')))
    return res

  const enc = request.method === 'HEAD' ? undefined : pickEncoding(request.headers.get('accept-encoding'))
  if (enc === undefined) {
    try {
      appendVaryAcceptEncoding(res.headers)
    }
    catch {}
    return res
  }

  const cl = res.headers.get('content-length')
  if (cl !== null && Number(cl) < MIN_COMPRESS_BYTES) {
    try {
      appendVaryAcceptEncoding(res.headers)
    }
    catch {}
    return res
  }

  if (res.body === null)
    return res

  const raw = new Uint8Array(await res.arrayBuffer())
  const compressed = cache.compress(raw, enc)
  const headers = new Headers(res.headers)
  appendVaryAcceptEncoding(headers)
  if (compressed === undefined)
    return new Response(raw, { status: res.status, statusText: res.statusText, headers })

  headers.set('content-encoding', enc)
  headers.delete('content-length')
  return new Response(compressed, { status: res.status, statusText: res.statusText, headers })
}
