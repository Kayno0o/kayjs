// Zero-dependency native HTTP compression (Bun.zstdCompressSync / Bun.gzipSync) with bounded byte-budget LRU.
// Never imports `node:zlib` so server RSS stays minimal.

export type CompressionEncoding = 'zstd' | 'gzip'
export type PrecompressedEncoding = 'br' | 'gzip'

const MIN_COMPRESS_BYTES = 256
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

const Q_VALUE_RE = /;\s*q\s*=\s*([0-9.]+)/i

// The `first` token wins ties; a token the header omits or gives q=0 never wins. Headers without q-values (the usual browser ones) take the allocation-free path.
function pickToken<A extends string, B extends string>(acceptEncoding: string, first: A | undefined, second: B | undefined): A | B | undefined {
  if (!acceptEncoding.includes(';')) {
    const lower = acceptEncoding.toLowerCase()
    if (first !== undefined && hasToken(lower, first))
      return first
    return second !== undefined && hasToken(lower, second) ? second : undefined
  }

  let firstQ = -1
  let secondQ = -1
  for (const rawPart of acceptEncoding.split(',')) {
    const part = rawPart.trim()
    const semi = part.indexOf(';')
    const name = (semi === -1 ? part : part.slice(0, semi)).trim().toLowerCase()
    if (name !== first && name !== second)
      continue
    let q = 1
    if (semi !== -1) {
      const parsed = Number(Q_VALUE_RE.exec(part.slice(semi))?.[1])
      if (!Number.isNaN(parsed))
        q = parsed
    }
    if (name === first)
      firstQ = q
    else
      secondQ = q
  }
  if (firstQ <= 0 && secondQ <= 0)
    return undefined
  return firstQ >= secondQ ? first : second
}

export function pickEncoding(acceptEncoding: string | null): CompressionEncoding | undefined {
  return acceptEncoding ? pickToken(acceptEncoding, 'zstd', 'gzip') : undefined
}

export function pickPrecompressedEncoding(
  acceptEncoding: string | null,
  available: { br?: boolean, gz?: boolean },
): PrecompressedEncoding | undefined {
  if (!acceptEncoding)
    return undefined
  return pickToken(acceptEncoding, available.br ? 'br' : undefined, available.gz ? 'gzip' : undefined)
}

export function toWeakEtag(etag: string): string {
  return etag.startsWith('W/') || etag.startsWith('w/') ? etag : `W/${etag}`
}

function hasNoTransform(cacheControl: string | null | undefined): boolean {
  return Boolean(cacheControl && /\bno-transform\b/i.test(cacheControl))
}

const PENDING: unique symbol = Symbol('pending')
const MAX_BUFFERED_PROBE_CHUNKS = 32
const MAX_BUFFERED_PROBE_BYTES = 4 * 1024 * 1024
const compressionHandled = new WeakSet<Response>()

/** Marks a `Response` as already processed for compression (compressed, too small, unshrinkable, or intentionally streamed). */
export function markCompressionHandled(res: Response): Response {
  compressionHandled.add(res)
  return res
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array<ArrayBuffer> {
  if (chunks.length === 1) {
    const only = chunks[0]!
    if (only.buffer instanceof ArrayBuffer && only.byteOffset === 0 && only.byteLength === only.buffer.byteLength)
      return only as Uint8Array<ArrayBuffer>
  }
  const out = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

// Microtask-only probe: buffered bodies (string, TypedArray, JSON, closed streams) settle all chunks
// within microtasks and can be compressed; open streams stay pending and pass straight through unbuffered.
export async function readBufferedOrPassThrough(
  res: Response,
): Promise<{ buffered: Uint8Array<ArrayBuffer> } | { passthrough: Response }> {
  const te = res.headers.get('transfer-encoding')
  if (te !== null && te.toLowerCase().includes('chunked'))
    return { passthrough: res }
  if (res.body === null)
    return { buffered: new Uint8Array(0) }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let pendingRead: ReturnType<typeof reader.read> | undefined

  while (true) {
    const readPromise = reader.read()
    void readPromise.catch(() => undefined)
    const tick = Promise.resolve().then(() => Promise.resolve()).then((): typeof PENDING => PENDING)
    const outcome = await Promise.race([readPromise, tick])
    if (outcome === PENDING) {
      pendingRead = readPromise
      break
    }
    if (outcome.done) {
      reader.releaseLock()
      return { buffered: concatChunks(chunks, totalBytes) }
    }
    chunks.push(outcome.value)
    totalBytes += outcome.value.byteLength
    if (chunks.length >= MAX_BUFFERED_PROBE_CHUNKS || totalBytes > MAX_BUFFERED_PROBE_BYTES)
      break
  }

  let chunkIdx = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (chunkIdx < chunks.length) {
        controller.enqueue(chunks[chunkIdx++]!)
        return
      }
      const next = pendingRead !== undefined ? pendingRead : reader.read()
      pendingRead = undefined
      const { done, value } = await next
      if (done)
        controller.close()
      else
        controller.enqueue(value)
    },
    cancel(reason) {
      pendingRead = undefined
      return reader.cancel(reason)
    },
  })
  return {
    passthrough: new Response(stream, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    }),
  }
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

function compressBuffer(bytes: Uint8Array<ArrayBuffer>, encoding: CompressionEncoding): Uint8Array<ArrayBuffer> {
  if (encoding === 'zstd')
    return Bun.zstdCompressSync(bytes, { level: 3 }) as Uint8Array<ArrayBuffer>
  return Bun.gzipSync(bytes, { level: 6 }) as Uint8Array<ArrayBuffer>
}

// `undefined` when the input is too small to be worth compressing or does not shrink.
function shrink(bytes: Uint8Array<ArrayBuffer>, encoding: CompressionEncoding): Uint8Array<ArrayBuffer> | undefined {
  if (bytes.byteLength < MIN_COMPRESS_BYTES)
    return undefined
  const compressed = compressBuffer(bytes, encoding)
  return compressed.byteLength < bytes.byteLength ? compressed : undefined
}

const DEFAULT_MAX_FILE_CACHE_BYTES = 8 * 1024 * 1024

export class CompressionCache {
  // Path-keyed build files (assets, public, prerendered pages): bounded byte-budget LRU + in-flight dedup. `null` marks a file that does not shrink.
  readonly #files = new Map<string, Uint8Array<ArrayBuffer> | null>()
  readonly #fileInflight = new Map<string, Promise<Uint8Array<ArrayBuffer> | undefined>>()
  readonly #maxFileBytes: number
  readonly #maxFileEntryBytes: number
  #fileBytes = 0
  // Content-hashed HTML of routes rendered per request: a byte-budget LRU.
  readonly #map = new Map<string, Uint8Array<ArrayBuffer>>()
  readonly #maxBytes: number
  readonly #maxEntryBytes: number
  #totalBytes = 0

  constructor(maxBytes = DEFAULT_MAX_CACHE_BYTES, maxFileBytes = DEFAULT_MAX_FILE_CACHE_BYTES) {
    this.#maxBytes = maxBytes
    this.#maxEntryBytes = Math.floor(maxBytes / 4)
    this.#maxFileBytes = maxFileBytes
    this.#maxFileEntryBytes = Math.floor(maxFileBytes / 4)
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
    const cacheKey = staticKey !== undefined ? `${encoding}:${staticKey}` : undefined
    const cached = cacheKey !== undefined ? this.get(cacheKey) : undefined
    if (cached !== undefined)
      return cached
    const compressed = shrink(bytes, encoding)
    if (compressed !== undefined && cacheKey !== undefined)
      this.set(cacheKey, compressed)
    return compressed
  }

  /** The compressed variant of a build file, read and compressed on its first request only (deduped + bounded LRU); `undefined` when it does not shrink. */
  async file(key: string, encoding: CompressionEncoding, read: () => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const variantKey = `${encoding}:${key}`
    if (this.#files.has(variantKey)) {
      const hit = this.#files.get(variantKey)!
      // Refresh LRU recency
      this.#files.delete(variantKey)
      this.#files.set(variantKey, hit)
      return hit ?? undefined
    }
    const inflight = this.#fileInflight.get(variantKey)
    if (inflight !== undefined)
      return inflight

    const task = (async () => {
      const bytes = await read()
      const variant = shrink(bytes, encoding) ?? null
      if (variant === null) {
        this.#files.set(variantKey, null)
        return undefined
      }
      if (variant.byteLength <= this.#maxFileEntryBytes) {
        this.#files.set(variantKey, variant)
        this.#fileBytes += variant.byteLength
        while (this.#fileBytes > this.#maxFileBytes) {
          const oldest = this.#files.keys().next()
          if (oldest.done)
            break
          const evicted = this.#files.get(oldest.value)
          this.#files.delete(oldest.value)
          if (evicted !== null && evicted !== undefined)
            this.#fileBytes -= evicted.byteLength
        }
      }
      return variant
    })()

    this.#fileInflight.set(variantKey, task)
    try {
      return await task
    }
    finally {
      this.#fileInflight.delete(variantKey)
    }
  }
}

export function mergeVaryValue(existing: string | null | undefined, token: string): string {
  if (!existing)
    return token
  const lowerToken = token.toLowerCase()
  const parts = existing.split(',').map(p => p.trim()).filter(Boolean)
  if (parts.some(p => p.toLowerCase() === lowerToken))
    return parts.join(', ')
  return `${parts.join(', ')}, ${token}`
}

function appendVaryAcceptEncoding(headers: Headers): void {
  headers.set('vary', mergeVaryValue(headers.get('vary'), 'Accept-Encoding'))
}

function tryAppendVaryAcceptEncoding(res: Response): Response {
  try {
    appendVaryAcceptEncoding(res.headers)
    return res
  }
  catch {
    const headers = new Headers(res.headers)
    appendVaryAcceptEncoding(headers)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }
}

function withVaryAcceptEncoding(baseHeaders: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...baseHeaders }
  let existing: string | undefined
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'vary') {
      existing = existing !== undefined ? `${existing}, ${headers[key]}` : headers[key]
      if (key !== 'vary')
        delete headers[key]
    }
  }
  headers.vary = mergeVaryValue(existing, 'Accept-Encoding')
  return headers
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
        const headers = withVaryAcceptEncoding(baseHeaders)
        headers['content-encoding'] = enc
        const etag = headers.etag ?? headers.ETag
        if (etag !== undefined) {
          delete headers.ETag
          headers.etag = toWeakEtag(etag)
        }
        return markCompressionHandled(new Response(compressed, { status, headers }))
      }
    }
  }
  return markCompressionHandled(new Response(request.method === 'HEAD' ? null : html, {
    status,
    headers: cache !== undefined && !noTransform ? withVaryAcceptEncoding(baseHeaders) : baseHeaders,
  }))
}

function compressedResponseFrom(res: Response, compressed: Uint8Array<ArrayBuffer>, enc: CompressionEncoding): Response {
  const headers = new Headers(res.headers)
  appendVaryAcceptEncoding(headers)
  headers.set('content-encoding', enc)
  headers.delete('content-length')
  const etag = headers.get('etag')
  if (etag !== null)
    headers.set('etag', toWeakEtag(etag))
  return markCompressionHandled(new Response(compressed, { status: res.status, statusText: res.statusText, headers }))
}

export async function maybeCompressResponse(
  res: Response,
  request: Request,
  cache: CompressionCache | undefined,
  staticKey?: string,
): Promise<Response> {
  if (cache === undefined || compressionHandled.has(res))
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
  const enc = request.method === 'HEAD' ? undefined : pickEncoding(request.headers.get('accept-encoding'))
  if (enc === undefined)
    return markCompressionHandled(tryAppendVaryAcceptEncoding(res))

  if (cl !== null && Number(cl) < MIN_COMPRESS_BYTES)
    return markCompressionHandled(tryAppendVaryAcceptEncoding(res))

  if (res.body === null)
    return res

  if (staticKey !== undefined) {
    let readRaw: Uint8Array<ArrayBuffer> | undefined
    const compressed = await cache.file(staticKey, enc, async () => {
      readRaw = new Uint8Array(await res.arrayBuffer())
      return readRaw
    })
    if (compressed !== undefined)
      return compressedResponseFrom(res, compressed, enc)
    if (readRaw !== undefined) {
      const headers = new Headers(res.headers)
      appendVaryAcceptEncoding(headers)
      return markCompressionHandled(new Response(readRaw, { status: res.status, statusText: res.statusText, headers }))
    }
    return markCompressionHandled(tryAppendVaryAcceptEncoding(res))
  }

  let raw: Uint8Array<ArrayBuffer>
  if (cl !== null) {
    raw = new Uint8Array(await res.arrayBuffer())
  }
  else {
    const probe = await readBufferedOrPassThrough(res)
    if ('passthrough' in probe)
      return markCompressionHandled(probe.passthrough)
    raw = probe.buffered
  }
  const compressed = cache.compress(raw, enc)
  if (compressed === undefined) {
    const headers = new Headers(res.headers)
    appendVaryAcceptEncoding(headers)
    return markCompressionHandled(new Response(raw, { status: res.status, statusText: res.statusText, headers }))
  }
  return compressedResponseFrom(res, compressed, enc)
}
