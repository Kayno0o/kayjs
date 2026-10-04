import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants } from 'node:zlib'

export type Encoding = 'br' | 'gzip'

// Best first: brotli is smaller, gzip what every browser takes.
const SUFFIXES: Record<Encoding, string> = { br: '.br', gzip: '.gz' }
const ENCODINGS = Object.keys(SUFFIXES) as Encoding[]
// Text the build writes; images, fonts and media come compressed already.
const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|txt|xml|map|wasm)$/i
const ENCODED_COPY = /\.(?:br|gz)$/
// Below this a response fits in a packet or two anyway.
const MIN_SIZE = 256
const ACCEPTED = /^\s*([\w*-]+)\s*(?:;\s*q\s*=\s*([\d.]+))?/i
const compressBrotli = promisify(brotliCompress)

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
