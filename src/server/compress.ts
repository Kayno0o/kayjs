import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nodeZlib } from './builtins'

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
const COMPRESSING_AT_ONCE = 4
const compressing = (() => {
  let active = 0
  const waiting: (() => void)[] = []

  return {
    async acquire() {
      if (active >= COMPRESSING_AT_ONCE)
        await new Promise<void>(resolve => waiting.push(resolve))
      else
        active++
    },
    // A waiting body takes over the slot, so `active` only drops once none waits.
    release() {
      const next = waiting.shift()

      if (next)
        next()
      else
        active--
    },
  }
})()

// One body compressed whole, off the main thread, at the levels of the request path. Brotli's window is cut to the body, since a larger one only costs memory: 4 MB at its default.
async function compressBytes(bytes: Uint8Array, encoding: Encoding): Promise<Uint8Array<ArrayBuffer>> {
  await compressing.acquire()

  try {
    if (encoding === 'gzip')
      return await compressGzip(bytes, GZIP_LEVEL)

    const { constants } = nodeZlib()
    const window = Math.min(Math.max(Math.ceil(Math.log2(bytes.length)), constants.BROTLI_MIN_WINDOW_BITS), constants.BROTLI_MAX_WINDOW_BITS)

    return await compressBrotli(bytes, { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [constants.BROTLI_PARAM_LGWIN]: window, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length })
  }
  finally {
    compressing.release()
  }
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
// A body complete within a tick, as a rendered string is, is compressed in one go with a window cut to its size, and gets a length; a streamed one is flushed chunk by chunk, so what the server sends early still reaches the browser early.
// A response left alone is answered synchronously: Elysia sends an empty body for a `mapResponse` promise resolving to undefined.
export function compressResponse(request: Request, response: Response): Response | undefined | Promise<Response> {
  const { headers, status } = response
  const length = headers.get('content-length')
  const size = length === null ? wholeSizes.get(response) : Number(length)

  if (!response.body || request.method === 'HEAD' || BODILESS.has(status) || headers.has('content-encoding') || NO_TRANSFORM.test(headers.get('cache-control') ?? '') || !COMPRESSIBLE_TYPE.test(headers.get('content-type') ?? '') || (size !== undefined && size < MIN_SIZE))
    return undefined

  const encoding = preferredEncoding(request.headers.get('accept-encoding'), ON_THE_FLY)

  // Whatever the browser takes, a shared cache keeps one copy per encoding; one taking none gets the response as it is, its body never read.
  if (!encoding) {
    varyOnEncoding(headers)

    return undefined
  }

  return compressBody(response, wholeSizes.has(response) ? response : response.body, encoding)
}

function varyOnEncoding(headers: Headers): void {
  if (!VARY_ENCODING.test(headers.get('vary') ?? ''))
    headers.append('vary', 'accept-encoding')
}

async function compressBody({ headers, status, statusText }: Response, source: Response | ReadableStream<Uint8Array>, encoding: Encoding): Promise<Response> {
  // From here on the body is read off the response, so every path answers a new one.
  const body: ReadBody = source instanceof Response ? { whole: true, bytes: await source.bytes() } : await readWithinTick(source)

  if (body.whole && body.bytes.length < MIN_SIZE)
    return new Response(body.bytes, { status, statusText, headers })

  varyOnEncoding(headers)

  const plain = () => new Response(body.whole ? body.bytes : body.stream, { status, statusText, headers })

  const compressed = new Headers(headers)
  const etag = compressed.get('etag')

  compressed.set('content-encoding', encoding)
  compressed.delete('content-length')

  // The bytes differ from the uncompressed copy's, so a strong tag no longer holds.
  if (etag?.startsWith('"'))
    compressed.set('etag', `W/${etag}`)

  if (!body.whole)
    return new Response(compressedStream(body.stream, encoding), { status, statusText, headers: compressed })

  const copy = await compressBytes(body.bytes, encoding)

  return copy.length < body.bytes.length * 0.9 ? new Response(copy, { status, statusText, headers: compressed }) : plain()
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
      return { whole: true, bytes: Buffer.concat(chunks) as Uint8Array<ArrayBuffer> }

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
