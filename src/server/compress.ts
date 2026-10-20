import type { LoadedDictionary, ServedDictionary } from './dictionary'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nodeZlib } from './builtins'
import { dictionaryAsked, dictionaryBody, dictionaryBodySync } from './dictionary'
import { limiter } from './limit'

export type Encoding = 'zstd' | 'br' | 'gzip'
// The encodings of the copies `kay build` writes beside a file, at levels too slow for a request.
export type StoredEncoding = Exclude<Encoding, 'zstd'>

// Best first among those at hand: zstd compresses a page while serving at about a quarter of brotli's CPU for 5 to 8% more bytes, brotli at its strongest is the smallest copy written once, gzip what every browser takes.
const ENCODINGS: Encoding[] = ['zstd', 'br', 'gzip']
const SUFFIXES: Record<StoredEncoding, string> = { br: '.br', gzip: '.gz' }
const STORED: StoredEncoding[] = ['br', 'gzip']
// While serving, gzip before brotli: at the levels a request affords, brotli costs about what gzip does for bytes no fewer on a page, and only it needs node:zlib loaded.
const ON_THE_FLY_ORDER: Encoding[] = ['zstd', 'gzip', 'br']
const ON_THE_FLY: ReadonlySet<Encoding> = new Set(ON_THE_FLY_ORDER)
// Brotli and gzip alone for a copy compressed once and sent many times, where zstd's extra bytes would go out on every reply, and for a stream, which holds its encoder's memory while open, brotli's cut window less than zstd's.
const ONCE_OR_STREAMED: ReadonlySet<StoredEncoding> = new Set(STORED)
const GZIP_ONLY: ReadonlySet<Encoding> = new Set(['gzip'])
// A gzip member's header: deflate, no name or time, from an unknown system.
const GZIP_HEADER = new Uint8Array([0x1F, 0x8B, 8, 0, 0, 0, 0, 0, 0, 0xFF])
// Enough of a fixed text to tell it from the others at a `<style>` tag, past that tag every stylesheet starts with.
const HEAD_BYTES = 72
const HTML_TYPE = /^text\/html/i
// Text the build writes, and the fonts with no compression of their own; images, woff fonts and media come compressed already.
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|txt|xml|map|wasm|ttf|otf)$/i
const ENCODED_COPY = /\.(?:br|gz)$/
// Below this a response fits in a packet or two anyway.
const MIN_SIZE = 256
const ACCEPTED = /^\s*([\w*-]+)\s*(?:;\s*q\s*=\s*([\d.]+))?/i
// The `Accept-Encoding` headers kept parsed: a few browsers' worth, so headers made up to fill it cost nothing more than parsing.
const KEPT_ACCEPTS = 64
const KEPT_ACCEPT_LENGTH = 256
const acceptedWeights = new Map<string, Record<Encoding, number>>()
// Levels for what compresses while serving: brotli 4 costs a third less CPU than 5 on a 110 KB page for 6% more bytes, about what gzip 6 costs; zstd 3 about a quarter of either.
const BROTLI_QUALITY = 4
const GZIP_LEVEL = 6
const ZSTD_LEVEL = 3
const VARY_DICTIONARY = /\bavailable-dictionary\b/i

// Response types worth compressing: text, the structured data and scripts sent as text, and the fonts that carry no compression of their own.
export const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|ld\+json|rss\+xml|atom\+xml|wasm|(?:x-)?ndjson)|font\/(?:ttf|otf)|image\/svg\+xml)/i
// Statuses with no body to compress, or a partial one.
const BODILESS = new Set([101, 204, 205, 206, 304])
const NO_TRANSFORM = /\bno-transform\b/i
const VARY_ENCODING = /\baccept-encoding\b/i

// What a body is compressed with: an encoding, or a dictionary.
type Compressor = Encoding | { dictionary: LoadedDictionary, id: string }

// One body through brotli or gzip, off the main thread.
async function compressBrotli(bytes: Uint8Array, params: Record<number, number>): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => nodeZlib().brotliCompress(bytes, { params }, (error, result) => error ? reject(error) : resolve(new Uint8Array(result))))
}

async function compressGzip(bytes: Uint8Array, level: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => nodeZlib().gzip(bytes, { level }, (error, result) => error ? reject(error) : resolve(new Uint8Array(result))))
}

// Writes a brotli and a gzip copy beside every compressible file under the directory, at the strongest levels since it happens once, at build time; a copy saving little is not written.
export async function compressFiles(dir: string, copiesOf: StrongestCopies = strongestCopies): Promise<void> {
  await compressPaths(await filesUnder(dir), copiesOf)
}

export type StrongestCopies = (bytes: Uint8Array<ArrayBuffer>) => Promise<Partial<Record<StoredEncoding, Uint8Array<ArrayBuffer>>>>

// The same for the files listed, those not worth compressing left out; `copiesOf` makes the copies of one file's bytes, which a build backs with a cache.
export async function compressPaths(paths: string[], copiesOf: StrongestCopies = strongestCopies): Promise<void> {
  await Promise.all(paths.filter(path => COMPRESSIBLE.test(path)).map(async (path) => {
    const bytes = await Bun.file(path).bytes()

    if (bytes.length < MIN_SIZE)
      return

    await Promise.all(Object.entries(await copiesOf(bytes)).map(async ([encoding, copy]) => Bun.write(encodedPath(path, encoding as StoredEncoding), copy)))
  }))
}

// The copies `kay build` writes, for text rendered while serving but off any request's path, as a stale page rendered again.
export async function compressTextStrongest(text: string): Promise<Partial<Record<StoredEncoding, Uint8Array<ArrayBuffer>>>> {
  const bytes = new TextEncoder().encode(text)

  return bytes.length < MIN_SIZE ? {} : strongestCopies(bytes)
}

export async function strongestCopies(bytes: Uint8Array<ArrayBuffer>): Promise<Partial<Record<StoredEncoding, Uint8Array<ArrayBuffer>>>> {
  const { constants } = nodeZlib()
  const copies: [StoredEncoding, Uint8Array<ArrayBuffer>][] = [
    ['br', await compressBrotli(bytes, { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length })],
    ['gzip', Bun.gzipSync(bytes, { level: 9 })],
  ]

  return Object.fromEntries(copies.filter(([, copy]) => copy.length < bytes.length * 0.9))
}

// A brotli and a gzip copy of text rendered while serving, at levels quick enough for a request path; none below the size worth it, nor one saving little.
export async function compressText(text: string): Promise<Partial<Record<StoredEncoding, Uint8Array<ArrayBuffer>>>> {
  const bytes = new TextEncoder().encode(text)
  const copies: Partial<Record<StoredEncoding, Uint8Array<ArrayBuffer>>> = {}

  if (bytes.length < MIN_SIZE)
    return copies

  for (const encoding of STORED) {
    const copy = await compressBytes(bytes, encoding)

    if (copy.length < bytes.length * 0.9)
      copies[encoding] = copy
  }

  return copies
}

// A reply every request gets alike, as the sitemap or the worker: compressed once per encoding, by the first request taking it, rather than on every one. One taking none, or a body too small to compress, gets it whole for the compression hook to judge.
export function fixedReply(body: string | Promise<string>, headers: Record<string, string>): (request: Request) => Promise<Response> {
  const copies = new Map<Encoding, Promise<Uint8Array<ArrayBuffer> | undefined>>()

  return async (request) => {
    const text = await body
    const encoding = text.length < MIN_SIZE ? undefined : preferredEncoding(request.headers.get('accept-encoding'), ONCE_OR_STREAMED)

    if (!encoding)
      return wholeResponse(text, { headers })

    let copy = copies.get(encoding)

    if (!copy)
      copies.set(encoding, copy = shrunk(new TextEncoder().encode(text), encoding))

    let bytes: Uint8Array<ArrayBuffer> | undefined

    try {
      bytes = await copy
    }
    // A failed run is tried again by the next request, this one going out whole; a retry already stored by a newer request stays.
    catch {
      if (copies.get(encoding) === copy)
        copies.delete(encoding)
    }

    return bytes ? new Response(bytes, { headers: { ...headers, 'content-encoding': encoding, 'vary': 'accept-encoding' } }) : wholeResponse(text, { headers })
  }
}

async function shrunk(bytes: Uint8Array<ArrayBuffer>, encoding: Encoding): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const copy = await compressBytes(bytes, encoding)

  return copy.length < bytes.length * 0.9 ? copy : undefined
}

// At most this many bodies compress at once: past it each costs more CPU, as the threads fight over caches, and its encoder's memory, for no more throughput.
const compressing = limiter(4)

// One body compressed whole, off the main thread, at the levels of the request path. Brotli's window is cut to the body, since a larger one only costs memory: 4 MB at its default.
async function compressBytes(bytes: Uint8Array, encoding: Compressor): Promise<Uint8Array<ArrayBuffer>> {
  return compressing(async () => {
    if (typeof encoding === 'object')
      return dictionaryBody(encoding.dictionary, bytes, ZSTD_LEVEL)

    if (encoding === 'zstd')
      return new Uint8Array(await Bun.zstdCompress(bytes, { level: ZSTD_LEVEL }))

    if (encoding === 'gzip')
      return compressGzip(bytes, GZIP_LEVEL)

    const { constants } = nodeZlib()

    return compressBrotli(bytes, { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [constants.BROTLI_PARAM_LGWIN]: brotliWindow(bytes.length), [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length })
  })
}

function brotliWindow(length: number): number {
  const { constants } = nodeZlib()

  return Math.min(Math.max(Math.ceil(Math.log2(length)), constants.BROTLI_MIN_WINDOW_BITS), constants.BROTLI_MAX_WINDOW_BITS)
}

// Up to this size a body compresses on the main thread, within its request's tick: it costs about a quarter less CPU than on zlib's threads, gzip needs no node:zlib loaded, and its reply goes out corked with a length. Past it, the main thread would stall for more than about half a millisecond on a typical page.
const COMPRESS_HERE_BYTES = 128 * 1024

function compressBytesHere(bytes: Uint8Array<ArrayBuffer>, encoding: Compressor): Uint8Array<ArrayBuffer> {
  if (typeof encoding === 'object')
    return dictionaryBodySync(encoding.dictionary, bytes, ZSTD_LEVEL)

  if (encoding === 'zstd')
    return new Uint8Array(Bun.zstdCompressSync(bytes, { level: ZSTD_LEVEL }))

  if (encoding === 'gzip')
    return Bun.gzipSync(bytes, { level: GZIP_LEVEL })

  const { brotliCompressSync, constants } = nodeZlib()

  return new Uint8Array(brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [constants.BROTLI_PARAM_LGWIN]: brotliWindow(bytes.length), [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }))
}

// Compressed copies of whole bodies by encoding and content, so a page rendering the same bytes again, as most do for every visitor, is not compressed again: a body is kept from its second sighting on, so pages unique to one visitor never fill it.
// The key's hash is seeded per process and checked against a second one, so making a body collide with another's takes the process's secret seed.
const KEPT_COPY_BYTES = 2 * 1024 * 1024
const SEEN_ONCE = 1024
const HASH_SEED = crypto.getRandomValues(new BigUint64Array(1))[0]!
const keptCopies = new Map<string, { check: bigint, copy: Uint8Array<ArrayBuffer> }>()
const seenOnce = new Map<string, bigint>()
let keptBytes = 0

function copyKey(bytes: Uint8Array, encoding: Compressor): { key: string, check: bigint } {
  return { key: `${typeof encoding === 'object' ? encoding.id : encoding}${bytes.length}:${Bun.hash.xxHash3(bytes, HASH_SEED)}`, check: BigInt(Bun.hash.wyhash(bytes, HASH_SEED)) }
}

function keptCopy(key: string, check: bigint): Uint8Array<ArrayBuffer> | undefined {
  const kept = keptCopies.get(key)

  if (kept?.check !== check)
    return undefined

  // Taken again, it goes to the back of the line to drop.
  keptCopies.delete(key)
  keptCopies.set(key, kept)

  return kept.copy
}

function keepCopy(key: string, check: bigint, copy: Uint8Array<ArrayBuffer>): void {
  if (seenOnce.get(key) !== check) {
    seenOnce.delete(key)
    seenOnce.set(key, check)

    if (seenOnce.size > SEEN_ONCE)
      seenOnce.delete(seenOnce.keys().next().value!)

    return
  }

  seenOnce.delete(key)

  if (copy.length > KEPT_COPY_BYTES / 8 || keptCopies.has(key))
    return

  keptCopies.set(key, { check, copy })
  keptBytes += copy.length

  for (const [oldest, { copy: dropped }] of keptCopies) {
    if (keptBytes <= KEPT_COPY_BYTES)
      break

    keptCopies.delete(oldest)
    keptBytes -= dropped.length
  }
}

// A whole body compressed at the levels of the request path, from the copies kept or within the tick when small, and whether it may go out past a macrotask: a kept copy may, as its page may have waited on I/O.
async function compressWhole(bytes: Uint8Array<ArrayBuffer>, encoding: Compressor): Promise<{ copy: Uint8Array<ArrayBuffer>, late: boolean }> {
  const { key, check } = copyKey(bytes, encoding)
  const kept = keptCopy(key, check)

  if (kept)
    return { copy: kept, late: true }

  const late = bytes.length > COMPRESS_HERE_BYTES
  const copy = late ? await compressBytes(bytes, encoding) : compressBytesHere(bytes, encoding)

  keepCopy(key, check, copy)

  return { copy, late }
}

// Text a page carries whole every time it carries it, as an inlined stylesheet: it starts with `<style>`.
export interface FixedText {
  // Tells the texts of a process apart, for the key of a page's kept copy.
  readonly id: number
  bytes: Buffer
  head: Buffer
  // Ends on a full flush, which empties the window, so it sits between two other deflate runs of a gzip member without either reaching into it. Deflated the first time a page carries the text, at the strongest level.
  readonly deflated: Buffer
}

export function fixedTexts(texts: string[]): FixedText[] {
  return [...new Set(texts)].map(fixedText)
}

let fixedTextIds = 0

export function fixedText(text: string): FixedText {
  if (!text.startsWith('<style>'))
    throw new TypeError('kay: a fixed text starts with <style>, the tag a response is searched at')

  const bytes = Buffer.from(text)
  const fixed: FixedText = {
    id: fixedTextIds++,
    bytes,
    head: bytes.subarray(0, HEAD_BYTES),
    get deflated() {
      const { constants, deflateRawSync } = nodeZlib()
      const deflated = deflateRawSync(bytes, { level: 9, finishFlush: constants.Z_FULL_FLUSH })

      Object.defineProperty(fixed, 'deflated', { value: deflated })

      return deflated
    },
  }

  return fixed
}

export const STYLE_TAG = '<style>'

const STYLE_OPEN = Buffer.from(STYLE_TAG)

// The fixed texts by their head, and the lengths a head has: a response is searched at its `<style>` tags alone, not once per text.
interface FixedIndex {
  byHead: Map<string, FixedText[]>
  lengths: number[]
}

const indexes = new WeakMap<FixedText[], FixedIndex>()

function indexOfFixed(fixed: FixedText[]): FixedIndex {
  let index = indexes.get(fixed)

  if (!index) {
    const byHead = new Map<string, FixedText[]>()

    for (const text of fixed) {
      const key = text.head.toString('latin1')

      const same = byHead.get(key)

      if (same)
        same.push(text)
      else
        byHead.set(key, [text])
    }

    index = { byHead, lengths: [...new Set(fixed.map(text => text.head.length))] }
    indexes.set(fixed, index)
  }

  return index
}

// Every fixed text the body holds, in body order.
function findFixed(body: Buffer, fixed: FixedText[]): Found[] {
  const { byHead, lengths } = indexOfFixed(fixed)
  const found: Found[] = []
  let end = 0

  for (let at = body.indexOf(STYLE_OPEN); at >= 0; at = body.indexOf(STYLE_OPEN, at + 1)) {
    // A text overlapping the one before is left to the deflate.
    if (at < end)
      continue

    for (const length of lengths) {
      const text = byHead.get(body.toString('latin1', at, at + length))?.find(one => body.subarray(at, at + one.bytes.length).equals(one.bytes))

      if (text) {
        found.push({ text, at })
        end = at + text.bytes.length

        break
      }
    }
  }

  return found
}

type Deflate = (bytes: Uint8Array, last: boolean) => Buffer | Promise<Buffer>

// A run ends on a full flush so the next can follow it, the last one finishing the member.
function runOptions(last: boolean): { level: number, finishFlush: number } {
  const { constants } = nodeZlib()

  return { level: GZIP_LEVEL, finishFlush: last ? constants.Z_FINISH : constants.Z_FULL_FLUSH }
}

const deflateRaw: Deflate = async (bytes, last) => new Promise((resolve, reject) => nodeZlib().deflateRaw(bytes, runOptions(last), (error, result) => error ? reject(error) : resolve(result)))

const deflateRawHere: Deflate = (bytes, last) => nodeZlib().deflateRawSync(bytes, runOptions(last))

// Up to this much left to deflate, the main thread deflates it: a page serves 15 to 20% more requests than through zlib's threads below it, 10 to 13% fewer past it (#141).
const SPLICE_HERE_BYTES = 32 * 1024

interface Found { text: FixedText, at: number }

// A gzip of the body that deflates only what lies around the fixed texts it holds, theirs deflated once already, and whether it waited on a zlib callback; undefined when it holds none.
async function splicedGzip(bytes: Uint8Array<ArrayBuffer>, fixed: FixedText[]): Promise<{ gzip: Uint8Array<ArrayBuffer>, late: boolean } | undefined> {
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
  const found = findFixed(body, fixed)

  return found.length === 0 ? undefined : gzipFound(body, found)
}

async function gzipFound(body: Buffer, found: Found[]): Promise<{ gzip: Uint8Array<ArrayBuffer>, late: boolean }> {
  const left = body.length - found.reduce((total, { text }) => total + text.bytes.length, 0)
  const { key, check } = splicedKey(body, found)
  const kept = keptCopy(key, check)

  if (kept)
    return { gzip: kept, late: true }

  const late = left > SPLICE_HERE_BYTES
  const gzip = late ? await compressing(async () => gzipAround(body, found, deflateRaw)) : await gzipAround(body, found, deflateRawHere)

  keepCopy(key, check, gzip)

  return { gzip, late }
}

// A page's kept copy is keyed on what lies around its fixed texts, a few KB where the texts are many: the texts are told by id, as the bytes found there equal theirs.
function splicedKey(body: Buffer, found: Found[]): { key: string, check: bigint } {
  const arounds: Uint8Array[] = []
  let cursor = 0

  for (const { text, at } of found) {
    arounds.push(body.subarray(cursor, at))
    cursor = at + text.bytes.length
  }

  arounds.push(body.subarray(cursor))

  return partsKey(arounds, found.map(({ text }) => text), body.length)
}

// The key of a body told by the bytes around its fixed texts, `arounds` one more than `texts`.
function partsKey(arounds: Uint8Array[], texts: FixedText[], length: number): { key: string, check: bigint } {
  let hash = HASH_SEED
  let second = HASH_SEED
  let at = 0
  let ids = ''

  for (const [index, text] of texts.entries()) {
    const around = arounds[index]!

    hash = Bun.hash.xxHash3(around, hash)
    second = BigInt(Bun.hash.wyhash(around, second))
    at += around.length
    ids += `${text.id}@${at},`
    at += text.bytes.length
  }

  const rest = arounds[texts.length]!

  return { key: `spliced${length}:${ids}${Bun.hash.xxHash3(rest, hash)}`, check: BigInt(Bun.hash.wyhash(rest, second)) }
}

// A page's body as its render put it together: the text around each fixed text it holds, one more string than texts, and the texts themselves. The body is the strings and texts alternating, which lets a copy kept for the same page be found without reading the body.
export interface BodyPieces {
  strings: string[]
  texts: FixedText[]
}

function piecesSize({ strings, texts }: BodyPieces): number {
  return strings.reduce((total, string) => total + Buffer.byteLength(string), 0) + texts.reduce((total, text) => total + text.bytes.length, 0)
}

// The kept gzip of a body in pieces, if one is kept for its bytes.
function keptPieces(pieces: BodyPieces): Uint8Array<ArrayBuffer> | undefined {
  const arounds = pieces.strings.map(string => Buffer.from(string))
  const size = arounds.reduce((total, around) => total + around.length, 0) + pieces.texts.reduce((total, text) => total + text.bytes.length, 0)
  const { key, check } = partsKey(arounds, pieces.texts, size)
  const gzip = keptCopy(key, check)

  return gzip && gzip.length < size * 0.9 ? gzip : undefined
}

// A part of a page cut at its holes, kept deflated only: the bytes are inflated for a browser taking no gzip, and `crc` and `shift` let the gzip trailer's crc be built without them.
export interface SplicePart {
  // Ends on a full flush, as `FixedText.deflated` does.
  deflated: Buffer
  // The crc-32 of the part's bytes, and their count.
  crc: number
  length: number
  // What appending `length` zero bytes does to a crc, as 32 columns: `shifted(shift, crc) ^ part.crc` is the crc of the text before the part followed by it.
  shift: Uint32Array
}

const CRC_POLY = 0xEDB88320

function matrixTimes(matrix: Uint32Array, vector: number): number {
  let sum = 0

  for (let bit = 0; vector !== 0; bit++, vector >>>= 1) {
    if ((vector & 1) !== 0)
      sum ^= matrix[bit]!
  }

  return sum >>> 0
}

function matrixSquare(square: Uint32Array, matrix: Uint32Array): void {
  for (let column = 0; column < 32; column++)
    square[column] = matrixTimes(matrix, matrix[column]!)
}

// What `length` zero bytes do to a crc, as zlib's crc32_combine builds it.
function zerosOperator(length: number): Uint32Array {
  const operator = new Uint32Array(32)

  for (let column = 0; column < 32; column++)
    operator[column] = 2 ** column >>> 0

  if (length === 0)
    return operator

  const even = new Uint32Array(32)
  const odd = new Uint32Array(32)

  odd[0] = CRC_POLY

  for (let column = 1; column < 32; column++)
    odd[column] = 2 ** (column - 1) >>> 0

  matrixSquare(even, odd)
  matrixSquare(odd, even)

  // The square-and-multiply over the bits of length, the matrices alternating, product kept in `operator`.
  const result = Uint32Array.from(operator)
  let remaining = length
  let from = odd
  let to = even

  while (remaining > 0) {
    matrixSquare(to, from)

    if ((remaining & 1) !== 0) {
      for (let column = 0; column < 32; column++)
        result[column] = matrixTimes(to, result[column]!)
    }

    remaining = Math.floor(remaining / 2)
    ;[from, to] = [to, from]
  }

  return result
}

// The same off the event loop, for a text cut from a page while serving it.
export async function splicePartAsync(text: string): Promise<SplicePart> {
  const { constants, deflateRaw, crc32 } = nodeZlib()
  const bytes = Buffer.from(text)
  const deflated = await compressing(async () => new Promise<Buffer>((resolve, reject) => deflateRaw(bytes, { level: 9, finishFlush: constants.Z_FULL_FLUSH }, (error, result) => error ? reject(error) : resolve(result))))

  return { deflated, crc: crc32(bytes), length: bytes.length, shift: zerosOperator(bytes.length) }
}

// The text of a part, inflated.
export function splicePartText(part: SplicePart): string {
  const { constants, inflateRawSync } = nodeZlib()

  return part.length === 0 ? '' : inflateRawSync(part.deflated, { finishFlush: constants.Z_SYNC_FLUSH }).toString()
}

// A gzip of the parts with markup rendered per request between them, which alone is deflated: a prerendered page around its server islands.
export async function gzipParts(parts: SplicePart[], between: string[]): Promise<Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>> {
  const { crc32, deflateRawSync } = nodeZlib()
  const markups = parts.map((_, index) => index < parts.length - 1 ? Buffer.from(between[index] ?? '') : Buffer.alloc(0))
  const late = markups.reduce((total, markup) => total + markup.length, 0) > SPLICE_HERE_BYTES
  const chunks: Uint8Array[] = []
  let crc = 0
  let length = 0

  for (const [index, part] of parts.entries()) {
    if (part.length > 0) {
      chunks.push(part.deflated)
      crc = (matrixTimes(part.shift, crc) ^ part.crc) >>> 0
      length += part.length
    }

    const markup = markups[index]!

    if (markup.length > 0) {
      chunks.push(late ? await compressing(async () => deflateRaw(markup, false)) : deflateRawSync(markup, runOptions(false)))
      crc = crc32(markup, crc)
      length += markup.length
    }
  }

  // An empty final block, which ends the member after the last full flush.
  chunks.push(deflateRawSync(Buffer.alloc(0), runOptions(true)))

  const gzip = gzipMember(chunks, crc, length)

  return late ? lateBody(gzip) : gzip
}

async function gzipAround(body: Buffer, found: Found[], deflate: Deflate): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = []
  let cursor = 0

  for (const { text, at } of found) {
    chunks.push(await deflate(body.subarray(cursor, at), false), text.deflated)
    cursor = at + text.bytes.length
  }

  chunks.push(await deflate(body.subarray(cursor), true))

  return gzipMember(chunks, nodeZlib().crc32(body), body.length)
}

// One gzip member of deflate runs that already end the stream: the header before them, the crc-32 and the length after.
function gzipMember(chunks: Uint8Array[], crc: number, length: number): Uint8Array<ArrayBuffer> {
  const gzip = new Uint8Array(GZIP_HEADER.length + chunks.reduce((total, chunk) => total + chunk.length, 0) + 8)
  let written = 0

  gzip.set(GZIP_HEADER, written)
  written += GZIP_HEADER.length

  for (const chunk of chunks) {
    gzip.set(chunk, written)
    written += chunk.length
  }

  const view = new DataView(gzip.buffer)

  view.setUint32(written, crc, true)
  view.setUint32(written + 4, length % 2 ** 32, true)

  return gzip
}

// The bytes of a route's own Response read whole, by the Response.
const readBodies = new WeakMap<Response, Uint8Array<ArrayBuffer>>()

// The response with the bytes its route holds already, which compression reads as they are rather than through a stream of the body.
export function readResponse(response: Response, bytes: Uint8Array<ArrayBuffer>): Response {
  readBodies.set(response, bytes)

  return response
}

// The size of each body kay made whole, or for a body in pieces a lower bound of it, so compression judges it and reads it without a stream: opening a reader on a body costs Bun about 6 µs, more than a small response costs in all.
const wholeSizes = new WeakMap<Response, number>()

// The pieces a page's body was put together from, for the responses made with them.
const wholePieces = new WeakMap<Response, BodyPieces>()

// The size compression judges a body by: its bytes, or for a body in pieces the fixed texts alone once they reach `MIN_SIZE`, as it only asks whether the body is small and counting the bytes of every piece was a visible part of a page rendered per request.
function sizeOf(body: string | Uint8Array<ArrayBuffer>, pieces: BodyPieces | undefined): number {
  if (pieces) {
    const fixed = pieces.texts.reduce((total, text) => total + text.bytes.length, 0)

    return fixed >= MIN_SIZE ? fixed : piecesSize(pieces)
  }

  return typeof body === 'string' ? Buffer.byteLength(body) : body.length
}

// A response whose body is a string or bytes, its size known to compression, and for a string the pieces it was put together from, if the render knows them.
export function wholeResponse(body: string | Uint8Array<ArrayBuffer>, init?: ResponseInit, pieces?: BodyPieces): Response {
  const response = new Response(body, init)

  wholeSizes.set(response, sizeOf(body, pieces))

  if (pieces)
    wholePieces.set(response, pieces)

  return response
}

// The response compressed on the fly for a browser that takes zstd, brotli or gzip, or undefined when it is not worth it: already encoded, not text, too small, or asked to be left alone.
// A body complete within a tick, as a rendered string is, is compressed in one go with a window cut to its size, and gets a length unless it waited on zlib's threads and goes out at 15 KB or more, compressed or not (`lateBody`); a streamed one is flushed chunk by chunk, so what the server sends early still reaches the browser early.
// A response left alone is answered synchronously: Elysia sends an empty body for a `mapResponse` promise resolving to undefined.
// A whole page holding `fixed` texts goes as gzip to a browser taking it, whatever weight it gives zstd or brotli: only the rest of it is compressed, where brotli would compress it all, as its streams cannot be joined.
// A page of a build with a dictionary names it in a `Link` header, and goes out as the difference from it to a browser holding it, in place of the other encodings; a streamed one goes as it did.
export function compressResponse(request: Request, response: Response, fixed?: FixedText[], report?: (error: Error) => void, dictionary?: ServedDictionary): Response | undefined | Promise<Response> {
  const { headers, status } = response
  const html = dictionary !== undefined && !BODILESS.has(status) && HTML_TYPE.test(headers.get('content-type') ?? '')

  if (html)
    advertise(headers, dictionary)

  const length = headers.get('content-length')
  const size = length === null ? wholeSizes.get(response) : Number(length)

  if (request.method === 'HEAD' || BODILESS.has(status) || headers.has('content-encoding') || NO_TRANSFORM.test(headers.get('cache-control') ?? '') || !COMPRESSIBLE_TYPE.test(headers.get('content-type') ?? '') || (size !== undefined && size < MIN_SIZE))
    return undefined

  const encoding = html && dictionaryAsked(request, dictionary.ref) ? dictionary : preferredEncoding(request.headers.get('accept-encoding'), ON_THE_FLY, ON_THE_FLY_ORDER)
  const read = readBodies.get(response)

  // A streamed body is sent once: a route returning it again gets an error naming it, rather than an empty or broken reply.
  if (!read && response.bodyUsed) {
    report?.(new Error(`${new URL(request.url).pathname} answered a Response whose body was already sent: a route streaming its body returns a new Response each time`))

    return new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }

  // Whatever the browser takes, a shared cache keeps one copy per encoding; one taking none gets the response as it is, its body never read, or what was read of it before.
  if (encoding === undefined) {
    varyOnEncoding(headers)

    return read && new Response(read, { status, statusText: response.statusText, headers })
  }

  if (read)
    return compressBody(response, read, encoding, request.headers.get('accept-encoding'))

  // The body is looked at last: asking a file response for it makes a stream of the file, which Bun sends slower than the file itself.
  if (!response.body)
    return undefined

  const splice = typeof encoding === 'string' && fixed !== undefined && fixed.length > 0 && HTML_TYPE.test(headers.get('content-type') ?? '') && preferredEncoding(request.headers.get('accept-encoding'), GZIP_ONLY) !== undefined ? fixed : undefined

  const pieces = splice ? wholePieces.get(response) : undefined

  return compressBody(response, wholeSizes.has(response) ? response : response.body, encoding, request.headers.get('accept-encoding'), splice, pieces)
}

function advertise(headers: Headers, { link }: ServedDictionary): void {
  headers.append('link', link)
  varyOnEncoding(headers)

  if (!VARY_DICTIONARY.test(headers.get('vary') ?? ''))
    headers.append('vary', 'available-dictionary')
}

function varyOnEncoding(headers: Headers): void {
  if (!VARY_ENCODING.test(headers.get('vary') ?? ''))
    headers.append('vary', 'accept-encoding')
}

function encodingName(encoding: Encoding | ServedDictionary): Encoding | 'dcz' {
  return typeof encoding === 'string' ? encoding : 'dcz'
}

function compressedHeaders(headers: Headers, used: Encoding | 'dcz'): Headers {
  const compressed = new Headers(headers)
  const etag = compressed.get('etag')

  compressed.set('content-encoding', used)
  compressed.delete('content-length')

  // The bytes differ from the uncompressed copy's, so a strong tag no longer holds.
  if (etag?.startsWith('"'))
    compressed.set('etag', `W/${etag}`)

  return compressed
}

async function compressBody(response: Response, source: Response | ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>, encoding: Encoding | ServedDictionary, accept: string | null, fixed?: FixedText[], pieces?: BodyPieces): Promise<Response> {
  const { headers, status, statusText } = response

  // A page whose render knows its pieces and whose gzip is kept is answered without reading its body.
  const kept = pieces && keptPieces(pieces)

  if (kept) {
    // The page's text, never read, is let go at once rather than held until a collection: about 20 MiB of peak memory at 16 connections.
    if (source instanceof Response)
      void source.body?.cancel()

    varyOnEncoding(headers)

    return new Response(lateBody(kept), { status, statusText, headers: compressedHeaders(headers, 'gzip') })
  }

  // From here on the body is read off the response, so every path answers a new one.
  const body: ReadBody = source instanceof ReadableStream ? await readWithinTick(source) : { whole: true, bytes: source instanceof Uint8Array ? source : await source.bytes() }

  // A route may return the same Response again, whose body this read used up: the next request gets these bytes.
  if (body.whole && source instanceof ReadableStream)
    readBodies.set(response, body.bytes)

  if (body.whole && body.bytes.length < MIN_SIZE)
    return new Response(body.bytes, { status, statusText, headers })

  varyOnEncoding(headers)

  if (!body.whole) {
    const streamed = preferredEncoding(accept, ONCE_OR_STREAMED)

    return streamed ? new Response(compressedStream(body.stream, streamed), { status, statusText, headers: compressedHeaders(headers, streamed) }) : new Response(body.stream, { status, statusText, headers })
  }

  const spliced = fixed && await splicedGzip(body.bytes, fixed)
  const { copy, late } = spliced ? { copy: spliced.gzip, late: spliced.late } : await compressWhole(body.bytes, typeof encoding === 'string' ? encoding : { dictionary: await encoding.load(), id: `dcz:${encoding.ref.hash}:` })
  const reply = (bytes: Uint8Array<ArrayBuffer>) => late ? lateBody(bytes) : bytes

  return copy.length < body.bytes.length * 0.9 ? new Response(reply(copy), { status, statusText, headers: compressedHeaders(headers, spliced ? 'gzip' : encodingName(encoding)) }) : new Response(reply(body.bytes), { status, statusText, headers })
}

// Bun writes a reply resolved after a macrotask, a zlib callback included, uncorked once its body reaches this size: each header name, value and separator goes as its own send(), some forty segments a reply (#141). `lateBody` can go once oven-sh/bun#41341 corks every write.
const UNCORKED_BYTES = 15 * 1024

// Bytes past that go as a stream already holding them, whose head Bun corks: it serves about as fast as bytes answered within the request's tick, with no content-length.
function lateBody(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> {
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
function compressedStream(body: ReadableStream<Uint8Array>, encoding: StoredEncoding): ReadableStream<Uint8Array> {
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
export function encodedCopies(files: string[]): Map<string, Set<StoredEncoding>> {
  const copies = new Map<string, Set<StoredEncoding>>()

  for (const path of files) {
    if (!ENCODED_COPY.test(path))
      continue

    const original = path.slice(0, path.lastIndexOf('.'))

    copies.set(original, (copies.get(original) ?? new Set()).add(path.endsWith(SUFFIXES.br) ? 'br' : 'gzip'))
  }

  return copies
}

export function encodedPath(path: string, encoding: StoredEncoding): string {
  return `${path}${SUFFIXES[encoding]}`
}

// The best of the encodings at hand the request accepts, read off `Accept-Encoding` with its `q` weights, a tie going to the first in `order`; `q=0` refuses one.
export function preferredEncoding<E extends Encoding>(accept: string | null, available: ReadonlySet<E> | undefined, order: readonly Encoding[] = ENCODINGS): E | undefined {
  if (accept === null || accept === '' || !available || available.size === 0)
    return undefined

  const weights = encodingWeights(accept)
  let best: E | undefined

  for (const encoding of order as E[]) {
    if (available.has(encoding) && weights[encoding] > 0 && (best === undefined || weights[encoding] > weights[best]))
      best = encoding
  }

  return best
}

// What `accept` weighs each encoding at, parsed once per header: browsers send a handful, and a page, its assets and the compression of its reply all ask.
function encodingWeights(accept: string): Record<Encoding, number> {
  const known = acceptedWeights.get(accept)

  if (known)
    return known

  const weights = new Map<string, number>()

  for (const part of accept.split(',')) {
    const match = ACCEPTED.exec(part)

    if (match)
      weights.set(match[1]!.toLowerCase(), match[2] === undefined ? 1 : Number(match[2]))
  }

  const weight = (encoding: Encoding) => weights.get(encoding) ?? weights.get('*') ?? 0
  const parsed = { zstd: weight('zstd'), br: weight('br'), gzip: weight('gzip') }

  if (accept.length <= KEPT_ACCEPT_LENGTH && acceptedWeights.size < KEPT_ACCEPTS)
    acceptedWeights.set(accept, parsed)

  return parsed
}

export async function filesUnder(dir: string): Promise<string[]> {
  if (!existsSync(dir))
    return []

  const entries = await readdir(dir, { recursive: true, withFileTypes: true })

  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}
