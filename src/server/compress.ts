import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nodeZlib } from './builtins'
import { limiter } from './limit'

export type Encoding = 'br' | 'gzip'

// Best first: brotli is smaller, gzip what every browser takes.
const SUFFIXES: Record<Encoding, string> = { br: '.br', gzip: '.gz' }
const ENCODINGS = Object.keys(SUFFIXES) as Encoding[]
const ON_THE_FLY: ReadonlySet<Encoding> = new Set(ENCODINGS)
const GZIP_ONLY: ReadonlySet<Encoding> = new Set(['gzip'])
// A gzip member's header: deflate, no name or time, from an unknown system.
const GZIP_HEADER = new Uint8Array([0x1F, 0x8B, 8, 0, 0, 0, 0, 0, 0, 0xFF])
// Enough of a fixed text to find it by, past the `<style>` every stylesheet starts with: looking for one whole costs about 100 µs on a 110 KB page.
const HEAD_BYTES = 72
const HTML_TYPE = /^text\/html/i
// Text the build writes; images, fonts and media come compressed already.
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|txt|xml|map|wasm)$/i
const ENCODED_COPY = /\.(?:br|gz)$/
// Below this a response fits in a packet or two anyway.
const MIN_SIZE = 256
const ACCEPTED = /^\s*([\w*-]+)\s*(?:;\s*q\s*=\s*([\d.]+))?/i
// Levels for what compresses while serving: brotli 4 costs a third less CPU than 5 on a 110 KB page for 6% more bytes, about what gzip 6 costs.
const BROTLI_QUALITY = 4
const GZIP_LEVEL = 6
// Response types worth compressing: text, and the structured data and scripts sent as text.
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|ld\+json|rss\+xml|atom\+xml|wasm)|image\/svg\+xml)/i
// Statuses with no body to compress, or a partial one.
const BODILESS = new Set([101, 204, 205, 206, 304])
const NO_TRANSFORM = /\bno-transform\b/i
const VARY_ENCODING = /\baccept-encoding\b/i

// One body through brotli or gzip, off the main thread.
async function compressBrotli(bytes: Uint8Array, params: Record<number, number>): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => nodeZlib().brotliCompress(bytes, { params }, (error, result) => error ? reject(error) : resolve(new Uint8Array(result))))
}

async function compressGzip(bytes: Uint8Array, level: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => nodeZlib().gzip(bytes, { level }, (error, result) => error ? reject(error) : resolve(new Uint8Array(result))))
}

// Writes a brotli and a gzip copy beside every compressible file under the directory, at the strongest levels since it happens once, at build time; a copy saving little is not written.
export async function compressFiles(dir: string): Promise<void> {
  await compressPaths(await filesUnder(dir))
}

// The same for the files listed, those not worth compressing left out.
export async function compressPaths(paths: string[]): Promise<void> {
  await Promise.all(paths.filter(path => COMPRESSIBLE.test(path)).map(async (path) => {
    const bytes = await Bun.file(path).bytes()

    if (bytes.length < MIN_SIZE)
      return

    const { constants } = nodeZlib()
    const copies: [Encoding, Uint8Array][] = [
      ['br', await compressBrotli(bytes, { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length })],
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

  for (const encoding of ENCODINGS) {
    const copy = await compressBytes(bytes, encoding)

    if (copy.length < bytes.length * 0.9)
      copies[encoding] = copy
  }

  return copies
}

// At most this many bodies compress at once: past it each costs more CPU, as the threads fight over caches, and its encoder's memory, for no more throughput.
const compressing = limiter(4)

// One body compressed whole, off the main thread, at the levels of the request path. Brotli's window is cut to the body, since a larger one only costs memory: 4 MB at its default.
async function compressBytes(bytes: Uint8Array, encoding: Encoding): Promise<Uint8Array<ArrayBuffer>> {
  return compressing(async () => {
    if (encoding === 'gzip')
      return compressGzip(bytes, GZIP_LEVEL)

    const { constants } = nodeZlib()
    const window = Math.min(Math.max(Math.ceil(Math.log2(bytes.length)), constants.BROTLI_MIN_WINDOW_BITS), constants.BROTLI_MAX_WINDOW_BITS)

    return compressBrotli(bytes, { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [constants.BROTLI_PARAM_LGWIN]: window, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length })
  })
}

// Text a page carries whole every time it carries it, as an inlined stylesheet.
export interface FixedText {
  bytes: Buffer
  head: Buffer
  // Ends on a full flush, which empties the window, so it sits between two other deflate runs of a gzip member without either reaching into it.
  deflated: Buffer
}

// Each text deflated once, at the strongest level.
export function fixedTexts(texts: string[]): FixedText[] {
  const { constants, deflateRawSync } = nodeZlib()

  return [...new Set(texts)].map((text) => {
    const bytes = Buffer.from(text)

    return { bytes, head: bytes.subarray(0, HEAD_BYTES), deflated: deflateRawSync(bytes, { level: 9, finishFlush: constants.Z_FULL_FLUSH }) }
  })
}

function offsetOf(body: Buffer, text: FixedText): number {
  for (let at = body.indexOf(text.head); at >= 0; at = body.indexOf(text.head, at + 1)) {
    if (body.subarray(at, at + text.bytes.length).equals(text.bytes))
      return at
  }

  return -1
}

type Deflate = (bytes: Uint8Array, last: boolean) => Buffer | Promise<Buffer>

// A run ends on a full flush so the next can follow it, the last one finishing the member.
function runOptions(last: boolean): { level: number, finishFlush: number } {
  const { constants } = nodeZlib()

  return { level: GZIP_LEVEL, finishFlush: last ? constants.Z_FINISH : constants.Z_FULL_FLUSH }
}

const deflateRaw: Deflate = async (bytes, last) => new Promise((resolve, reject) => nodeZlib().deflateRaw(bytes, runOptions(last), (error, result) => error ? reject(error) : resolve(result)))

const deflateRawHere: Deflate = (bytes, last) => nodeZlib().deflateRawSync(bytes, runOptions(last))

// Up to this much left to deflate, the main thread deflates it sooner than it hands it to zlib's threads and takes it back: a short inlined page serves 15 to 20% more requests, one with 40 KB left 10% fewer (#141).
const SPLICE_HERE_BYTES = 32 * 1024

interface Found { text: FixedText, at: number }

// A gzip of the body that deflates only what lies around the fixed texts it holds, theirs deflated once already, and whether it waited on a zlib callback; undefined when it holds none.
async function splicedGzip(bytes: Uint8Array<ArrayBuffer>, fixed: FixedText[]): Promise<{ gzip: Uint8Array<ArrayBuffer>, late: boolean } | undefined> {
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
  const found: Found[] = []
  let end = 0

  // In body order, a text overlapping the one before left to the deflate.
  for (const one of fixed.map(text => ({ text, at: offsetOf(body, text) })).filter(({ at }) => at >= 0).sort((a, b) => a.at - b.at)) {
    if (one.at >= end) {
      found.push(one)
      end = one.at + one.text.bytes.length
    }
  }

  if (found.length === 0)
    return undefined

  const left = body.length - found.reduce((total, { text }) => total + text.bytes.length, 0)

  return left <= SPLICE_HERE_BYTES ? { gzip: await gzipAround(body, found, deflateRawHere), late: false } : { gzip: await compressing(async () => gzipAround(body, found, deflateRaw)), late: true }
}

async function gzipAround(body: Buffer, found: Found[], deflate: Deflate): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [GZIP_HEADER]
  let cursor = 0

  for (const { text, at } of found) {
    parts.push(await deflate(body.subarray(cursor, at), false), text.deflated)
    cursor = at + text.bytes.length
  }

  const trailer = new Uint8Array(8)
  const view = new DataView(trailer.buffer)

  parts.push(await deflate(body.subarray(cursor), true), trailer)
  view.setUint32(0, nodeZlib().crc32(body), true)
  view.setUint32(4, body.length % 2 ** 32, true)

  const gzip = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let written = 0

  for (const part of parts) {
    gzip.set(part, written)
    written += part.length
  }

  return gzip
}

// The size of each body kay made whole, so compression judges it and reads it without a stream: opening a reader on a body costs Bun about 6 µs, more than a small response costs in all.
const wholeSizes = new WeakMap<Response, number>()

// A response whose body is a string or bytes, its size known to compression.
export function wholeResponse(body: string | Uint8Array<ArrayBuffer>, init?: ResponseInit): Response {
  const response = new Response(body, init)

  wholeSizes.set(response, typeof body === 'string' ? Buffer.byteLength(body) : body.length)

  return response
}

// The response compressed on the fly for a browser that takes brotli or gzip, or undefined when it is not worth it: already encoded, not text, too small, or asked to be left alone.
// A body complete within a tick, as a rendered string is, is compressed in one go with a window cut to its size, and gets a length unless zlib's threads compressed it past 15 KB (`lateBody`); a streamed one is flushed chunk by chunk, so what the server sends early still reaches the browser early.
// A response left alone is answered synchronously: Elysia sends an empty body for a `mapResponse` promise resolving to undefined.
// A whole page holding `fixed` texts goes as gzip to a browser taking it, whatever weight it gives brotli: only the rest of it is compressed, where brotli would compress it all, as its streams cannot be joined.
export function compressResponse(request: Request, response: Response, fixed?: FixedText[]): Response | undefined | Promise<Response> {
  const { headers, status } = response
  const length = headers.get('content-length')
  const size = length === null ? wholeSizes.get(response) : Number(length)

  if (request.method === 'HEAD' || BODILESS.has(status) || headers.has('content-encoding') || NO_TRANSFORM.test(headers.get('cache-control') ?? '') || !COMPRESSIBLE_TYPE.test(headers.get('content-type') ?? '') || (size !== undefined && size < MIN_SIZE))
    return undefined

  const encoding = preferredEncoding(request.headers.get('accept-encoding'), ON_THE_FLY)

  // Whatever the browser takes, a shared cache keeps one copy per encoding; one taking none gets the response as it is, its body never read.
  if (!encoding) {
    varyOnEncoding(headers)

    return undefined
  }

  // The body is looked at last: asking a file response for it makes a stream of the file, which Bun sends slower than the file itself.
  if (!response.body)
    return undefined

  const splice = fixed !== undefined && fixed.length > 0 && HTML_TYPE.test(headers.get('content-type') ?? '') && preferredEncoding(request.headers.get('accept-encoding'), GZIP_ONLY) !== undefined ? fixed : undefined

  return compressBody(response, wholeSizes.has(response) ? response : response.body, encoding, splice)
}

function varyOnEncoding(headers: Headers): void {
  if (!VARY_ENCODING.test(headers.get('vary') ?? ''))
    headers.append('vary', 'accept-encoding')
}

async function compressBody({ headers, status, statusText }: Response, source: Response | ReadableStream<Uint8Array>, encoding: Encoding, fixed?: FixedText[]): Promise<Response> {
  // From here on the body is read off the response, so every path answers a new one.
  const body: ReadBody = source instanceof Response ? { whole: true, bytes: await source.bytes() } : await readWithinTick(source)

  if (body.whole && body.bytes.length < MIN_SIZE)
    return new Response(body.bytes, { status, statusText, headers })

  varyOnEncoding(headers)

  const compressedHeaders = (used: Encoding) => {
    const compressed = new Headers(headers)
    const etag = compressed.get('etag')

    compressed.set('content-encoding', used)
    compressed.delete('content-length')

    // The bytes differ from the uncompressed copy's, so a strong tag no longer holds.
    if (etag?.startsWith('"'))
      compressed.set('etag', `W/${etag}`)

    return compressed
  }

  if (!body.whole)
    return new Response(compressedStream(body.stream, encoding), { status, statusText, headers: compressedHeaders(encoding) })

  const spliced = fixed && await splicedGzip(body.bytes, fixed)
  const copy = spliced?.gzip ?? await compressBytes(body.bytes, encoding)
  const reply = (bytes: Uint8Array<ArrayBuffer>) => spliced?.late === false ? bytes : lateBody(bytes)

  return copy.length < body.bytes.length * 0.9 ? new Response(reply(copy), { status, statusText, headers: compressedHeaders(spliced ? 'gzip' : encoding) }) : new Response(reply(body.bytes), { status, statusText, headers })
}

// Bun writes a reply resolved after a macrotask, a zlib callback included, uncorked once its body reaches this size: each header name, value and separator goes as its own send(), some forty segments a reply (#141, oven-sh/bun#41341).
const UNCORKED_BYTES = 15 * 1024

// Bytes past that go as a stream already holding them, whose head Bun corks: it serves about as fast as bytes answered within the request's tick, with no content-length.
function lateBody(bytes: Uint8Array<ArrayBuffer>): BodyInit {
  return bytes.length < UNCORKED_BYTES
    ? bytes
    : new ReadableStream({ start(controller) {
      controller.enqueue(bytes)
      controller.close()
    } })
}

type ReadBody = { whole: true, bytes: Uint8Array<ArrayBuffer> } | { whole: false, stream: ReadableStream<Uint8Array> }

// The body whole when it ends within a tick, else a stream giving back what was read before the rest.
async function readWithinTick(body: ReadableStream<Uint8Array>): Promise<ReadBody> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let pending: ReturnType<typeof reader.read> | undefined

  for (;;) {
    const read = reader.read()
    const result = await Promise.race([read, new Promise<undefined>(resolve => setImmediate(resolve))])

    if (!result) {
      pending = read

      break
    }

    if (result.done)
      return { whole: true, bytes: Buffer.concat(chunks) }

    chunks.push(result.value)
  }

  return {
    whole: false,
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = chunks.shift()

        if (chunk)
          return controller.enqueue(chunk)

        const { value, done } = await (pending ?? reader.read())

        pending = undefined

        if (done)
          controller.close()
        else
          controller.enqueue(value)
      },
      async cancel(reason) {
        await reader.cancel(reason)
      },
    }),
  }
}

// The levels of the request path. Brotli's window is cut to 512 KB, more than a page needs, since its default 4 MB is memory held per open stream.
// Each chunk is flushed and sent before the next is read, so at most one waits in zlib; a browser going away stops both the source and zlib.
function compressedStream(body: ReadableStream<Uint8Array>, encoding: Encoding): ReadableStream<Uint8Array> {
  const { constants, createBrotliCompress, createGzip } = nodeZlib()
  const encoder = encoding === 'br' ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [constants.BROTLI_PARAM_LGWIN]: 19 } }) : createGzip({ level: GZIP_LEVEL })
  const reader = body.getReader()
  const output: Uint8Array[] = []
  let failure: Error | undefined
  const stopped = new Promise<void>(resolve => encoder.once('error', (error: Error) => {
    failure = error
    resolve()
  }))
  // A zlib error fails the response's stream instead of the process.
  const settle = async (operation: Promise<void>) => {
    await Promise.race([operation, stopped])

    if (failure)
      throw failure
  }

  encoder.on('data', (chunk: Uint8Array) => output.push(chunk))

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read()

      if (done) {
        // 'end' comes once the last bytes went out as data.
        const ended = new Promise<void>(resolve => encoder.once('end', resolve))

        encoder.end()
        await settle(ended)
      }
      else {
        encoder.write(value)
        await settle(new Promise<void>(resolve => encoder.flush(() => resolve())))
      }

      for (const chunk of output.splice(0))
        controller.enqueue(chunk)

      if (done)
        controller.close()
    },
    async cancel(reason) {
      encoder.destroy()
      await reader.cancel(reason)
    },
  })
}

// The copies `compressFiles` wrote among the files, by the path of the file they copy.
export function encodedCopies(files: string[]): Map<string, Set<Encoding>> {
  const copies = new Map<string, Set<Encoding>>()

  for (const path of files) {
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
  if (accept === null || accept === '' || !available || available.size === 0)
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

export async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir))
    return []

  const entries = await readdir(dir, { recursive: true, withFileTypes: true })

  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}
