import type { ClientBuild } from './client'
import { join } from 'node:path'
import { ASSET_PREFIX } from '../build/assets'
import { joinBase } from '../runtime/base'
import { nodeZlib } from './builtins'
import { limiter } from './limit'

// Compression Dictionary Transport (RFC 9842): the 404 page of a build is its dictionary, and a page goes to a browser that holds it as the page's difference from it.
export const DICTIONARY_PREFIX = 'dictionary-'
export const DCZ_SUFFIX = '.dcz'
// Below this a dictionary saves a page too little to be worth the browser fetching it.
const MIN_DICTIONARY_BYTES = 1024
// Section 5.1 of the RFC: the eight bytes every dcz body starts with, then the SHA-256 of the dictionary.
const DCZ_MAGIC = new Uint8Array([0x5E, 0x2A, 0x4D, 0x18, 0x20, 0, 0, 0])
// Clients take a window of 8 MB at least, or 1.25 times the dictionary's size; a page and its dictionary are far below 4 MB.
const WINDOW_LOG = 22
// Pages shrink by a further 3% at the strongest level over level 9, written once at build time.
const BUILD_LEVEL = 19
const COPIES_AT_ONCE = 8
const MIN_PAGE_BYTES = 256
const DCZ_WEIGHT = /(?:^|,)\s*dcz\s*(?:;\s*q\s*=\s*([\d.]+)\s*)?(?=,|$)/i

// What the manifest names of a build's dictionary.
export interface DictionaryRef {
  // Its file in the browser build, served under `/_kay/`.
  file: string
  // The SHA-256 of its bytes, in base64.
  hash: string
}

// The dictionary a build's pages are compressed against, as a server holds it.
export interface ServedDictionary {
  ref: DictionaryRef
  // The `Link` header every page carries, which has the browser fetch the dictionary once it is idle.
  link: string
  // Reads the bytes the first time a page is compressed on the fly; a prerendered page needs none.
  load: () => Promise<LoadedDictionary>
}

// A dictionary read for compressing: its bytes, and the 40 bytes starting a body compressed with it.
export interface LoadedDictionary {
  bytes: Uint8Array<ArrayBuffer>
  header: Uint8Array<ArrayBuffer>
}

// The dictionary of a rendered 404 page, written into the build's directory under a name made of its hash; none when the page is too small to help.
export async function writeDictionary(clientDir: string, html: string): Promise<DictionaryRef | undefined> {
  const bytes = new TextEncoder().encode(html)

  if (bytes.length < MIN_DICTIONARY_BYTES)
    return undefined

  const digest = new Bun.CryptoHasher('sha256').update(bytes).digest()
  // A text file, so the build's compressed copies serve it shrunk: a browser keeps the bytes it decodes.
  const file = `${DICTIONARY_PREFIX}${digest.toString('hex').slice(0, 16)}.txt`

  await Bun.write(join(clientDir, file), bytes)

  return { file, hash: digest.toString('base64') }
}

export function servedDictionary(client: ClientBuild, base: string): ServedDictionary | undefined {
  const { dictionary } = client

  if (dictionary === undefined)
    return undefined

  let loaded: Promise<LoadedDictionary> | undefined

  const load = async () => {
    try {
      return await (loaded ??= loadDictionary(client, dictionary))
    }
    catch (error) {
      // The next page reads it again.
      loaded = undefined

      throw error
    }
  }

  return { ref: dictionary, link: dictionaryLink(base, dictionary), load }
}

async function loadDictionary(client: Pick<ClientBuild, 'dir'>, { file, hash }: DictionaryRef): Promise<LoadedDictionary> {
  const bytes = await Bun.file(join(client.dir, file)).bytes()
  const header = new Uint8Array(DCZ_MAGIC.length + 32)

  header.set(DCZ_MAGIC)
  header.set(Buffer.from(hash, 'base64'), DCZ_MAGIC.length)

  return { bytes, header }
}

// Whether the request holds this build's dictionary and takes dcz: the browser names it in `Available-Dictionary` as a structured-field byte sequence, and lists `dcz` in `Accept-Encoding` only for a request one of its dictionaries matches.
// Anything else, another build's dictionary included, is answered as a browser with none.
export function dictionaryAsked(request: Request, { hash }: DictionaryRef): boolean {
  const given = request.headers.get('available-dictionary')

  if (given === null || given.length !== hash.length + 2 || given !== `:${hash}:`)
    return false

  const weight = DCZ_WEIGHT.exec(request.headers.get('accept-encoding') ?? '')

  return weight !== null && (weight[1] === undefined || Number(weight[1]) > 0)
}

// The `match` of a dictionary used for every request under the mount point, whose root is the mount point itself: Chromium sends no `Available-Dictionary` on a `fetch()` once `match-dest` lists destinations, and a page swap is one.
export function useAsDictionary(base: string): string {
  return `match="${base === '' ? '/*' : `${base}{/*}?`}"`
}

// The `Link` header with which a page names the dictionary, which the browser then fetches once it is idle.
export function dictionaryLink(base: string, { file }: DictionaryRef): string {
  return `<${joinBase(base, `${ASSET_PREFIX}${file}`)}>; rel="compression-dictionary"`
}

// A page compressed against the dictionary, whole and within the tick.
export function dictionaryBodySync(dictionary: LoadedDictionary, bytes: Uint8Array, level: number): Uint8Array<ArrayBuffer> {
  const frame = nodeZlib().zstdCompressSync(bytes, zstdOptions(dictionary, level))

  return withHeader(dictionary, frame)
}

export async function dictionaryBody(dictionary: LoadedDictionary, bytes: Uint8Array, level: number): Promise<Uint8Array<ArrayBuffer>> {
  const frame = await new Promise<Buffer>((resolve, reject) => nodeZlib().zstdCompress(bytes, zstdOptions(dictionary, level), (error, result) => error ? reject(error) : resolve(result)))

  return withHeader(dictionary, frame)
}

function zstdOptions({ bytes }: LoadedDictionary, level: number) {
  const { constants } = nodeZlib()

  return { dictionary: bytes, params: { [constants.ZSTD_c_compressionLevel]: level, [constants.ZSTD_c_windowLog]: WINDOW_LOG } }
}

function withHeader({ header }: LoadedDictionary, frame: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = new Uint8Array(header.length + frame.length)

  body.set(header)
  body.set(frame, header.length)

  return body
}

// A copy of each prerendered page against the build's dictionary, beside the page, when it comes out smaller than the copy a browser with no dictionary gets.
export async function writeDictionaryCopies(pagesDir: string, client: ClientBuild): Promise<void> {
  const { dictionary } = client

  if (dictionary === undefined)
    return

  const loaded = await loadDictionary(client, dictionary)
  const limit = limiter(COPIES_AT_ONCE)

  await Promise.all([...client.pages.values()].map(async ({ file, islands, stamps, readsSite }) => limit(async () => {
    const path = join(pagesDir, file)
    const bytes = await Bun.file(path).bytes()
    const brotli = Bun.file(`${path}.br`)
    const rival = await brotli.exists() ? brotli.size : bytes.length * 0.9
    const body = bytes.length < MIN_PAGE_BYTES || islands !== undefined || stamps || readsSite ? undefined : await dictionaryBody(loaded, bytes, BUILD_LEVEL)

    if (body !== undefined && body.length < rival)
      await Bun.write(`${path}${DCZ_SUFFIX}`, body)
  })))
}
