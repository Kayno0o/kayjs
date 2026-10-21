import { decodeAvif } from './avif'

// What an image's first bytes say it is, for the formats Bun.Image cannot be trusted with: AVIF, which it decodes only through the system's codec, and GIF, of which it reads the first frame.
const GIF = [0x47, 0x49, 0x46, 0x38]
const AVIF_BRANDS = new Set(['avif', 'avis'])
// Enough of a file to hold its `ftyp` box and the brands it lists.
const HEAD = 64

// About 50 megapixels: a runtime image larger than that, which could take gigabytes to decode, is refused before any pixel is read.
export const MAX_UPLOAD_PIXELS = 50_000_000

export function isGif(bytes: Uint8Array): boolean {
  return GIF.every((byte, index) => bytes[index] === byte)
}

// An AVIF names itself in its `ftyp` box, as its major brand or among its compatible ones after a generic `mif1`.
export function isAvif(bytes: Uint8Array): boolean {
  if (fourCc(bytes, 4) !== 'ftyp')
    return false

  const end = Math.min(bytes.length, new DataView(bytes.buffer, bytes.byteOffset).getUint32(0))

  for (let at = 8; at + 4 <= end; at += at === 8 ? 8 : 4) {
    if (AVIF_BRANDS.has(fourCc(bytes, at)))
      return true
  }

  return false
}

// Whether a GIF holds more than one frame, read from its blocks without decoding any.
export function animatedGif(bytes: Uint8Array): boolean {
  let at = 13 + colorTable(bytes[10])
  let frames = 0

  while (at < bytes.length) {
    const block = bytes[at]

    if (block === 0x21) {
      at = subBlocksEnd(bytes, at + 2)
    }
    else if (block === 0x2C) {
      if (++frames > 1)
        return true

      at = subBlocksEnd(bytes, at + 10 + colorTable(bytes[at + 9]) + 1)
    }
    else {
      return false
    }
  }

  return false
}

// An AVIF's size, from the `ispe` property of its primary item, read without decoding it, with the most pixels any of its items claims.
export function avifSize(bytes: Uint8Array): { width: number, height: number, most: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const meta = boxes(bytes, 0, bytes.length).find(box => box.type === 'meta')
  const children = meta ? boxes(bytes, meta.start + 4, meta.end) : []
  const pitm = children.find(box => box.type === 'pitm')
  const iprp = children.find(box => box.type === 'iprp')
  const inside = iprp ? boxes(bytes, iprp.start, iprp.end) : []
  const ipco = inside.find(box => box.type === 'ipco')
  const ipma = inside.find(box => box.type === 'ipma')

  if (!pitm || !ipco || !ipma)
    return undefined

  const primary = bytes[pitm.start] === 0 ? view.getUint16(pitm.start + 4) : view.getUint32(pitm.start + 4)
  const properties = boxes(bytes, ipco.start, ipco.end)
  const sizes = properties.map(box => box.type === 'ispe' && box.start + 12 <= box.end ? { width: view.getUint32(box.start + 4), height: view.getUint32(box.start + 8) } : undefined)
  const most = Math.max(0, ...sizes.map(size => size ? size.width * size.height : 0))
  const wide = bytes[ipma.start] !== 0
  const large = (bytes[ipma.start + 3]! & 1) !== 0
  let at = ipma.start + 8

  for (let entry = view.getUint32(ipma.start + 4); entry > 0 && at < ipma.end; entry--) {
    const item = wide ? view.getUint32(at) : view.getUint16(at)
    const count = bytes[at + (wide ? 4 : 2)]!

    at += wide ? 5 : 3

    for (let association = 0; association < count; association++, at += large ? 2 : 1) {
      const index = large ? view.getUint16(at) & 0x7FFF : bytes[at]! & 0x7F
      const size = sizes[index - 1]

      if (item === primary && size)
        return { ...size, most }
    }
  }

  return undefined
}

// What Bun.Image reads of an image: an AVIF decoded to a PNG, anything else as it is. Past `maxPixels`, an AVIF is refused before a pixel is decoded, as Bun.Image refuses the others.
export async function decodable(source: Blob | Uint8Array, maxPixels?: number): Promise<Blob | Uint8Array> {
  if (!isAvif(await head(source)))
    return source

  // Its buffer goes to the worker, so a caller's own is copied.
  const bytes = source instanceof Uint8Array ? source.slice() : await source.bytes()

  return decodeAvif(bytes, checkedAvif(bytes, maxPixels))
}

// An image's size and format, from its header, an AVIF's included, and whether it is an animated GIF, which kay passes through rather than flatten to its first frame; refused past `maxPixels`.
export async function imageHeader(source: Blob | Uint8Array, maxPixels?: number): Promise<{ width: number, height: number, format: string, animated: boolean }> {
  const first = await head(source)

  if (isAvif(first))
    return { ...checkedAvif(source instanceof Uint8Array ? source : await source.bytes(), maxPixels), format: 'avif', animated: false }

  const { width, height, format } = await new Bun.Image(source, maxPixels === undefined ? {} : { maxPixels }).metadata()

  return { width, height, format, animated: isGif(first) && animatedGif(source instanceof Uint8Array ? source : await source.bytes()) }
}

async function head(source: Blob | Uint8Array): Promise<Uint8Array> {
  return source instanceof Uint8Array ? source : source.slice(0, HEAD).bytes()
}

function fourCc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + 4))
}

// The boxes between two offsets of an ISO media file, each by its type and where its content starts and ends.
function boxes(bytes: Uint8Array, start: number, end: number): { type: string, start: number, end: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const found: { type: string, start: number, end: number }[] = []
  let at = start

  while (at + 8 <= end) {
    const size = view.getUint32(at)
    const header = size === 1 ? 16 : 8
    let length = size

    if (size === 0)
      length = end - at
    else if (size === 1 && at + 16 <= end)
      length = Number(view.getBigUint64(at + 8))

    if (length < header || at + length > end)
      break

    found.push({ type: fourCc(bytes, at + 4), start: at + header, end: at + length })
    at += length
  }

  return found
}

function checkedAvif(bytes: Uint8Array, maxPixels: number | undefined): { width: number, height: number } {
  const size = avifSize(bytes)

  if (!size)
    throw new Error('kay: an AVIF with no size in its header')

  // Coded as Bun.Image codes the same refusal, so a caller tells it apart alike. Any item past the cap counts, as a grid's tile or a thumbnail could hide the size that decodes.
  if (maxPixels !== undefined && Math.max(size.width * size.height, size.most) > maxPixels)
    throw Object.assign(new Error(`kay: an image over ${maxPixels} pixels`), { code: 'ERR_IMAGE_TOO_MANY_PIXELS' })

  return { width: size.width, height: size.height }
}

// The bytes of a color table a packed field announces.
function colorTable(packed: number | undefined): number {
  return packed !== undefined && (packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 0x07) + 1) : 0
}

function subBlocksEnd(bytes: Uint8Array, at: number): number {
  let next = at

  while (next < bytes.length && bytes[next] !== 0)
    next += bytes[next]! + 1

  return next + 1
}
