import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, createBrotliCompress, createGzip } from 'node:zlib'

export type Encoding = 'br' | 'gzip'

// Best first: brotli is smaller, gzip what every browser takes.
const SUFFIXES: Record<Encoding, string> = { br: '.br', gzip: '.gz' }
const ENCODINGS = Object.keys(SUFFIXES) as Encoding[]
const ON_THE_FLY: ReadonlySet<Encoding> = new Set(ENCODINGS)
// Text the build writes; images, fonts and media come compressed already.
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|txt|xml|map|wasm)$/i
const ENCODED_COPY = /\.(?:br|gz)$/
// Below this a response fits in a packet or two anyway.
const MIN_SIZE = 256
const ACCEPTED = /^\s*([\w*-]+)\s*(?:;\s*q\s*=\s*([\d.]+))?/i
const compressBrotli = promisify(brotliCompress)
// Response types worth compressing: text, and the structured data and scripts sent as text.
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|ld\+json|rss\+xml|atom\+xml|wasm)|image\/svg\+xml)/i
// Statuses with no body to compress, or a partial one.
const BODILESS = new Set([101, 204, 205, 206, 304])
const NO_TRANSFORM = /\bno-transform\b/i

// Writes a brotli and a gzip copy beside every compressible file under the directory, at the strongest levels since it happens once, at build time; a copy saving little is not written.
export async function compressFiles(dir: string): Promise<void> {
  await Promise.all((await filesUnder(dir)).filter(path => COMPRESSIBLE.test(path)).map(async (path) => {
    const bytes = await Bun.file(path).bytes()

    if (bytes.length < MIN_SIZE)
      return

    const copies: [Encoding, Uint8Array][] = [
      ['br', await compressBrotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } })],
      ['gzip', Bun.gzipSync(bytes, { level: 9 })],
    ]

    await Promise.all(copies.filter(([, copy]) => copy.length < bytes.length * 0.9).map(async ([encoding, copy]) => Bun.write(encodedPath(path, encoding), copy)))
  }))
}

// A brotli and a gzip copy of text rendered while serving, at levels quick enough for a request path; none below the size worth it, nor one saving little.
export async function compressText(text: string): Promise<Partial<Record<Encoding, Uint8Array<ArrayBuffer>>>> {
  const bytes = new TextEncoder().encode(text)
  const copies: Partial<Record<Encoding, Uint8Array<ArrayBuffer>>> = {}

  if (bytes.length < MIN_SIZE)
    return copies

  const brotli = new Uint8Array(await compressBrotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }))
  const gzip = new Uint8Array(Bun.gzipSync(bytes, { level: 6 }))

  for (const [encoding, copy] of [['br', brotli], ['gzip', gzip]] as const) {
    if (copy.length < bytes.length * 0.9)
      copies[encoding] = copy
  }

  return copies
}

// The response compressed on the fly for a browser that takes brotli or gzip, or undefined when it is not worth it: already encoded, not text, too small, or asked to be left alone.
// A streamed body is flushed chunk by chunk, so what the server sends early still reaches the browser early.
export function compressResponse(request: Request, response: Response): Response | undefined {
  const { headers } = response
  const length = headers.get('content-length')

  if (!response.body || request.method === 'HEAD' || BODILESS.has(response.status) || headers.has('content-encoding') || NO_TRANSFORM.test(headers.get('cache-control') ?? '') || !COMPRESSIBLE_TYPE.test(headers.get('content-type') ?? '') || (length !== null && Number(length) < MIN_SIZE))
    return undefined

  // Whatever the browser takes, a shared cache keeps one copy per encoding.
  headers.append('vary', 'accept-encoding')

  const encoding = preferredEncoding(request.headers.get('accept-encoding'), ON_THE_FLY)

  if (!encoding)
    return undefined

  const compressed = new Headers(headers)
  const etag = compressed.get('etag')

  compressed.set('content-encoding', encoding)
  compressed.delete('content-length')

  // The bytes differ from the uncompressed copy's, so a strong tag no longer holds.
  if (etag?.startsWith('"'))
    compressed.set('etag', `W/${etag}`)

  return new Response(response.body.pipeThrough(compressor(encoding)), { status: response.status, statusText: response.statusText, headers: compressed })
}

// Levels quick enough for a request path: brotli 5 and gzip 6 compress a 150 KB page in a millisecond or so.
function compressor(encoding: Encoding): TransformStream<Uint8Array, Uint8Array> {
  const zlib = encoding === 'br' ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) : createGzip({ level: 6 })
  const output: Uint8Array[] = []

  zlib.on('data', (chunk: Uint8Array) => output.push(chunk))

  const drain = (controller: TransformStreamDefaultController<Uint8Array>) => {
    for (const chunk of output.splice(0))
      controller.enqueue(chunk)
  }

  return new TransformStream({
    async transform(chunk, controller) {
      zlib.write(chunk)
      await new Promise<void>(resolve => zlib.flush(() => resolve()))
      drain(controller)
    },
    async flush(controller) {
      // 'end' comes once the last bytes went out as data.
      const ended = new Promise<void>(resolve => zlib.once('end', resolve))

      zlib.end()
      await ended
      drain(controller)
    },
  })
}

// The copies `compressFiles` wrote, by the path of the file they copy.
export async function encodedCopies(dir: string): Promise<Map<string, Set<Encoding>>> {
  const copies = new Map<string, Set<Encoding>>()

  for (const path of await filesUnder(dir)) {
    if (!ENCODED_COPY.test(path))
      continue

    const original = path.slice(0, path.lastIndexOf('.'))

    copies.set(original, (copies.get(original) ?? new Set()).add(path.endsWith(SUFFIXES.br) ? 'br' : 'gzip'))
  }

  return copies
}

export function encodedPath(path: string, encoding: Encoding): string {
  return `${path}${SUFFIXES[encoding]}`
}

// The best of the encodings at hand the request accepts, read off `Accept-Encoding` with its `q` weights; `q=0` refuses one.
export function preferredEncoding(accept: string | null, available: ReadonlySet<Encoding> | undefined): Encoding | undefined {
  if (!accept || !available || available.size === 0)
    return undefined

  const weights = new Map<string, number>()

  for (const part of accept.split(',')) {
    const match = ACCEPTED.exec(part)

    if (match)
      weights.set(match[1]!.toLowerCase(), match[2] === undefined ? 1 : Number(match[2]))
  }

  const weight = (encoding: Encoding) => weights.get(encoding) ?? weights.get('*') ?? 0

  return ENCODINGS.filter(encoding => available.has(encoding) && weight(encoding) > 0).sort((a, b) => weight(b) - weight(a))[0]
}

async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir))
    return []

  const entries = await readdir(dir, { recursive: true, withFileTypes: true })

  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}
