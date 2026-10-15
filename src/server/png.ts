import { nodeZlib } from './builtins'

export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

// The pixels of a non-interlaced 8-bit RGBA PNG, Bun.Image giving no raw output.
export function decodePng(png: Uint8Array): { pixels: Uint8Array, width: number, height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)

  if (PNG_SIGNATURE.some((byte, index) => png[index] !== byte) || png[24] !== 8 || png[25] !== 6 || png[28] !== 0)
    throw new Error('not a non-interlaced 8-bit RGBA PNG')

  const width = view.getUint32(16)
  const height = view.getUint32(20)
  const data: Uint8Array[] = []

  for (let at = 8; at < png.length; at += 12 + view.getUint32(at)) {
    if (png[at + 4] === 0x49 && png[at + 5] === 0x44 && png[at + 6] === 0x41 && png[at + 7] === 0x54)
      data.push(png.subarray(at + 8, at + 8 + view.getUint32(at)))
  }

  const filtered = nodeZlib().inflateSync(Buffer.concat(data))
  const stride = width * 4
  const pixels = new Uint8Array(stride * height)

  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)]
    const line = filtered.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const row = pixels.subarray(y * stride, (y + 1) * stride)

    // Bun.Image writes every row of an uncompressed PNG unfiltered, copied whole rather than byte by byte.
    if (filter === 0) {
      row.set(line)

      continue
    }

    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined

    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? row[x - 4]! : 0
      const above = up ? up[x]! : 0
      const corner = up && x >= 4 ? up[x - 4]! : 0

      row[x] = (line[x]! + predict(filter, left, above, corner)) & 0xFF
    }
  }

  return { pixels, width, height }
}

// What PNG's filter types 0 to 4 add back to each byte.
function predict(filter: number | undefined, left: number, above: number, corner: number): number {
  switch (filter) {
    case 0:
      return 0
    case 1:
      return left
    case 2:
      return above
    case 3:
      return (left + above) >> 1
    case 4: {
      const estimate = left + above - corner
      const toLeft = Math.abs(estimate - left)
      const toAbove = Math.abs(estimate - above)
      const toCorner = Math.abs(estimate - corner)

      if (toLeft <= toAbove && toLeft <= toCorner)
        return left

      return toAbove <= toCorner ? above : corner
    }
    case undefined:
    default:
      throw new Error(`PNG filter type ${filter} is none of 0 to 4`)
  }
}

// RGBA pixels as an 8-bit PNG Bun.Image reads, for an image it cannot decode itself.
export function encodePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4
  const filtered = new Uint8Array((stride + 1) * height)

  for (let y = 0; y < height; y++)
    filtered.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)

  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)

  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 6, 0, 0, 0], 8)

  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', nodeZlib().deflateSync(filtered, { level: 1 })), pngChunk('IEND', new Uint8Array(0))])
}

// One chunk of a PNG: its length, its type, its data and the CRC of the type and data.
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)

  view.setUint32(0, data.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)))

  return out
}
