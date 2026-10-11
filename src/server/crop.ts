import { nodeZlib } from './builtins'
import { decodable } from './image-format'

// Bun.Image resizes but cannot cut: an image is written as a PNG this reads back row by row, and the middle of it written again.
const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
// Chunks a cut image keeps as they are: the palette and its transparency.
const KEPT_CHUNKS = new Set(['PLTE', 'tRNS'])

export interface Png {
  width: number
  height: number
  depth: number
  colorType: number
  // Bytes per pixel, at least 1, as PNG filters count them.
  bpp: number
  rows: Uint8Array[]
  kept: { type: string, data: Uint8Array }[]
}

// `source` resized to cover `width` by `height`, its middle kept, as a PNG.
// Shrunk, it is resized first, so the cut reads few pixels; enlarged, it is cut first, so a thin image is never blown up whole.
export async function coverImage(input: Blob | Uint8Array, width: number, height: number, maxPixels?: number): Promise<Uint8Array> {
  const source = await decodable(input, maxPixels)
  const limit = maxPixels === undefined ? {} : { maxPixels }
  const own = await new Bun.Image(source, limit).metadata()
  const scale = Math.max(width / own.width, height / own.height)

  if (scale <= 1) {
    const resized = await new Bun.Image(source, limit).resize(Math.max(width, Math.round(own.width * scale)), Math.max(height, Math.round(own.height * scale)), { fit: 'fill' }).png({ compressionLevel: 0 }).bytes()

    return encodePng(cropPng(decodePng(resized), width, height))
  }

  const whole = await new Bun.Image(source, limit).png({ compressionLevel: 0 }).bytes()
  const cut = encodePng(cropPng(decodePng(whole), Math.min(own.width, Math.max(1, Math.round(width / scale))), Math.min(own.height, Math.max(1, Math.round(height / scale)))))

  return new Bun.Image(cut).resize(width, height, { fit: 'fill' }).png({ compressionLevel: 0 }).bytes()
}

export function decodePng(bytes: Uint8Array): Png {
  if (!SIGNATURE.every((byte, index) => bytes[index] === byte))
    throw new Error('kay: not a PNG')

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const data: Uint8Array[] = []
  const kept: Png['kept'] = []
  let header: { width: number, height: number, depth: number, colorType: number } | undefined

  for (let offset = SIGNATURE.length; offset < bytes.length;) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const chunk = bytes.subarray(offset + 8, offset + 8 + length)

    if (type === 'IHDR') {
      if (chunk[12] !== 0)
        throw new Error('kay: an interlaced PNG cannot be cut')

      header = { width: view.getUint32(offset + 8), height: view.getUint32(offset + 12), depth: chunk[8]!, colorType: chunk[9]! }
    }
    else if (type === 'IDAT') {
      data.push(chunk)
    }
    else if (KEPT_CHUNKS.has(type)) {
      kept.push({ type, data: chunk })
    }

    offset += 12 + length
  }

  if (!header || header.depth < 8 || CHANNELS[header.colorType] === undefined)
    throw new Error('kay: a PNG of less than 8 bits per channel cannot be cut')

  const bpp = CHANNELS[header.colorType]! * header.depth / 8
  const stride = header.width * bpp
  const raw = nodeZlib().inflateSync(Buffer.concat(data))
  const rows: Uint8Array[] = []
  let previous: Uint8Array = new Uint8Array(stride)

  for (let y = 0; y < header.height; y++) {
    const start = y * (stride + 1)
    const row = unfilter(raw[start]!, raw.subarray(start + 1, start + 1 + stride), previous, bpp)

    rows.push(row)
    previous = row
  }

  return { ...header, bpp, rows, kept }
}

// A row as it was before the encoder's filter, given the row above it.
function unfilter(filter: number, filtered: Uint8Array, above: Uint8Array, bpp: number): Uint8Array {
  if (filter === 0)
    return filtered.slice()

  const row = new Uint8Array(filtered.length)

  for (let x = 0; x < filtered.length; x++) {
    const left = x >= bpp ? row[x - bpp]! : 0
    const up = above[x]!
    const corner = x >= bpp ? above[x - bpp]! : 0
    let predicted = 0

    if (filter === 1)
      predicted = left
    else if (filter === 2)
      predicted = up
    else if (filter === 3)
      predicted = (left + up) >> 1
    else if (filter === 4)
      predicted = paeth(left, up, corner)

    row[x] = (filtered[x]! + predicted) & 0xFF
  }

  return row
}

function paeth(left: number, up: number, corner: number): number {
  const estimate = left + up - corner
  const [toLeft, toUp, toCorner] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)]

  if (toLeft <= toUp && toLeft <= toCorner)
    return left

  return toUp <= toCorner ? up : corner
}

function cropPng(png: Png, width: number, height: number): Png {
  const x = Math.floor((png.width - width) / 2) * png.bpp
  const y = Math.floor((png.height - height) / 2)

  return { ...png, width, height, rows: png.rows.slice(y, y + height).map(row => row.subarray(x, x + width * png.bpp)) }
}

export function encodePng(png: Png): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)

  view.setUint32(0, png.width)
  view.setUint32(4, png.height)
  header.set([png.depth, png.colorType, 0, 0, 0], 8)

  // Each row unfiltered, filter type 0, which deflate packs well enough for an image about to be encoded again.
  const raw = new Uint8Array(png.height * (png.width * png.bpp + 1))

  for (const [y, row] of png.rows.entries())
    raw.set(row, y * (row.length + 1) + 1)

  const chunks = [chunk('IHDR', header), ...png.kept.map(({ type, data }) => chunk(type, data)), chunk('IDAT', nodeZlib().deflateSync(raw)), chunk('IEND', new Uint8Array())]

  return new Uint8Array(Buffer.concat([SIGNATURE, ...chunks]))
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  const typed = new TextEncoder().encode(type)

  view.setUint32(0, data.length)
  out.set(typed, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)))

  return out
}
