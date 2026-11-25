// Zero-dependency native HTTP compression (Bun.zstdCompressSync / Bun.gzipSync) with bounded byte-budget LRU.
// Never imports `node:zlib` so server RSS stays minimal.

export type CompressionEncoding = 'zstd' | 'gzip'
export type PrecompressedEncoding = 'br' | 'gzip'

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

export function pickPrecompressedEncoding(
  acceptEncoding: string | null,
  available: { br?: boolean, gz?: boolean },
): PrecompressedEncoding | undefined {
  if (!acceptEncoding || (!available.br && !available.gz))
    return undefined

  if (!acceptEncoding.includes(';')) {
    const lower = acceptEncoding.toLowerCase()
    if (available.br && hasToken(lower, 'br'))
      return 'br'
    if (available.gz && hasToken(lower, 'gzip'))
      return 'gzip'
    return undefined
  }

  let brQ = -1
  let gzipQ = -1
  const parts = acceptEncoding.split(',')
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!.trim()
    if (!part)
      continue
    const semi = part.indexOf(';')
    const name = (semi === -1 ? part : part.slice(0, semi)).trim().toLowerCase()
    if (name !== 'br' && name !== 'gzip')
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
    if (name === 'br')
      brQ = q
    else
      gzipQ = q
  }

  const effBr = available.br ? brQ : -1
  const effGz = available.gz ? gzipQ : -1
  if (effBr <= 0 && effGz <= 0)
    return undefined
  return effBr >= effGz ? 'br' : 'gzip'
}

export function toWeakEtag(etag: string): string {
  return etag.startsWith('W/') || etag.startsWith('w/') ? etag : `W/${etag}`
}

function hasNoTransform(cacheControl: string | null | undefined): boolean {
  return Boolean(cacheControl && /\bno-transform\b/i.test(cacheControl))
}

// Bun exposes no way to tell a streamed body from a buffered one without reading it, so its inspect output decides. Checked once at load: if the output no longer tells them apart, every body without a length counts as streamed and goes out uncompressed.
const STREAM_MARK = 'ReadableStream {'
const inspectSeesStreams = typeof Bun !== 'undefined'
  && Bun.inspect(new Response(new ReadableStream())).includes(STREAM_MARK)
  && !Bun.inspect(new Response('')).includes(STREAM_MARK)

function isStreamingBody(res: Response): boolean {
  const te = res.headers.get('transfer-encoding')
  if (te && te.toLowerCase().includes('chunked'))
    return true
  return !inspectSeesStreams || Bun.inspect(res).includes(STREAM_MARK)
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
  // Path-keyed build files (assets, public, prerendered pages): bounded by the build, so each variant is kept for the process. `null` marks a file that does not shrink.
  readonly #files = new Map<string, Uint8Array<ArrayBuffer> | null>()
  // Content-hashed HTML of routes rendered per request: a byte-budget LRU.
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

  /** Compresses `bytes`, kept in the LRU under `staticKey` when given; without one nothing is stored. */
  compress(bytes: Uint8Array<ArrayBuffer>, encoding: CompressionEncoding, staticKey?: string): Uint8Array<ArrayBuffer> | undefined {
    if (bytes.byteLength < MIN_COMPRESS_BYTES)
      return undefined
    const cacheKey = staticKey !== undefined ? `${encoding}:${staticKey}` : undefined
    const cached = cacheKey !== undefined ? this.get(cacheKey) : undefined
    if (cached !== undefined)
      return cached
    const compressed = compressBuffer(bytes, encoding)
    if (compressed.byteLength >= bytes.byteLength)
      return undefined
    if (cacheKey !== undefined)
      this.set(cacheKey, compressed)
    return compressed
  }

  /** The compressed variant of a build file, read and compressed on its first request only; `undefined` when it does not shrink. */
  async file(key: string, encoding: CompressionEncoding, read: () => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const variantKey = `${encoding}:${key}`
    let variant = this.#files.get(variantKey)
    if (variant === undefined) {
      const bytes = await read()
      variant = bytes.byteLength < MIN_COMPRESS_BYTES ? null : compressBuffer(bytes, encoding)
      if (variant !== null && variant.byteLength >= bytes.byteLength)
        variant = null
      this.#files.set(variantKey, variant)
    }
    return variant ?? undefined
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

/** `reuse` keeps the compressed page by content hash, for routes whose HTML holds nothing per visitor. */
export function compressedHtmlResponse(
  html: string,
  status: number,
  baseHeaders: Record<string, string>,
  request: Request,
  cache: CompressionCache | undefined,
  reuse = false,
): Response {
  const noTransform = hasNoTransform(baseHeaders['cache-control'] ?? baseHeaders['Cache-Control'])
  if (cache !== undefined && !noTransform && request.method !== 'HEAD') {
    const enc = pickEncoding(request.headers.get('accept-encoding'))
    if (enc !== undefined && html.length >= MIN_COMPRESS_BYTES) {
      const staticKey = reuse ? `s:${Bun.hash.wyhash(html).toString(36)}:${html.length}` : undefined
      let compressed = staticKey !== undefined ? cache.get(`${enc}:${staticKey}`) : undefined
      if (compressed === undefined)
        compressed = cache.compress(encoder.encode(html), enc, staticKey)
      if (compressed !== undefined) {
        const headers: Record<string, string> = { ...baseHeaders, 'content-encoding': enc, 'vary': 'Accept-Encoding' }
        const etag = headers.etag ?? headers.ETag
        if (etag !== undefined)
          headers.etag = toWeakEtag(etag)
        return new Response(compressed, { status, headers })
      }
    }
  }
  return new Response(request.method === 'HEAD' ? null : html, {
    status,
    headers: cache !== undefined && !noTransform ? { ...baseHeaders, vary: 'Accept-Encoding' } : baseHeaders,
  })
}

export async function maybeCompressResponse(
  res: Response,
  request: Request,
  cache: CompressionCache | undefined,
): Promise<Response> {
  if (cache === undefined)
    return res
  if (res.status === 204 || res.status === 206 || res.status === 304 || (res.status >= 300 && res.status < 400))
    return res
  if (res.headers.has('content-encoding'))
    return res
  if (hasNoTransform(res.headers.get('cache-control')))
    return res
  if (!isCompressibleType(res.headers.get('content-type')))
    return res

  const cl = res.headers.get('content-length')
  // Never buffer streaming responses that have no Content-Length (e.g. chunked streams, ReadableStream)
  if (cl === null && isStreamingBody(res))
    return res

  const enc = request.method === 'HEAD' ? undefined : pickEncoding(request.headers.get('accept-encoding'))
  if (enc === undefined) {
    try {
      appendVaryAcceptEncoding(res.headers)
    }
    catch {}
    return res
  }

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
  const etag = headers.get('etag')
  if (etag !== null)
    headers.set('etag', toWeakEtag(etag))
  return new Response(compressed, { status: res.status, statusText: res.statusText, headers })
}
