import { decodeAvif } from './avif'

// What an image's first bytes say it is, for the formats Bun.Image cannot be trusted with: AVIF, which it decodes only through the system's codec, and GIF, of which it reads the first frame.
const GIF = [0x47, 0x49, 0x46, 0x38]
const FTYP = [0x66, 0x74, 0x79, 0x70]
const AVIF_BRANDS = new Set(['avif', 'avis'])
const ISPE = [0x69, 0x73, 0x70, 0x65]
// Where an AVIF's properties sit, its pixels after them.
const AVIF_HEADER = 65_536

export function isGif(bytes: Uint8Array): boolean {
  return GIF.every((byte, index) => bytes[index] === byte)
}

export function isAvif(bytes: Uint8Array): boolean {
  return FTYP.every((byte, index) => bytes[index + 4] === byte) && AVIF_BRANDS.has(String.fromCharCode(...bytes.subarray(8, 12)))
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

// An AVIF's size, from its `ispe` property, read without decoding it.
export function avifSize(bytes: Uint8Array): { width: number, height: number } | undefined {
  const header = bytes.subarray(0, AVIF_HEADER)

  for (let at = 4; at + 16 <= header.length; at++) {
    if (ISPE.every((byte, index) => header[at + index] === byte)) {
      const view = new DataView(header.buffer, header.byteOffset + at + 8, 8)

      return { width: view.getUint32(0), height: view.getUint32(4) }
    }
  }

  return undefined
}

// What Bun.Image reads of an image: an AVIF decoded to a PNG, anything else as it is. Past `maxPixels`, an AVIF is refused before a pixel is decoded, as Bun.Image refuses the others.
export async function decodable(source: Blob | Uint8Array, maxPixels?: number): Promise<Blob | Uint8Array> {
  if (!isAvif(await head(source)))
    return source

  const bytes = source instanceof Uint8Array ? source : await source.bytes()

  checkedAvif(bytes, maxPixels)

  return decodeAvif(bytes)
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
  return source instanceof Uint8Array ? source : source.slice(0, 12).bytes()
}

function checkedAvif(bytes: Uint8Array, maxPixels: number | undefined): { width: number, height: number } {
  const size = avifSize(bytes)

  if (!size)
    throw new Error('kay: an AVIF with no size in its header')

  // Coded as Bun.Image codes the same refusal, so a caller tells it apart alike.
  if (maxPixels !== undefined && size.width * size.height > maxPixels)
    throw Object.assign(new Error(`kay: an image over ${maxPixels} pixels`), { code: 'ERR_IMAGE_TOO_MANY_PIXELS' })

  return size
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
