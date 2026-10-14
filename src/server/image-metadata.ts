// What a stored photo says beyond its pixels, such as where and when it was taken and on which camera, taken out on upload. The image's look is kept: its colour profile, and a JPEG's orientation, which Bun.Image and browsers apply.
const JPEG = [0xFF, 0xD8]
const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
const PNG_DROPPED = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME'])
const WEBP_DROPPED = new Set(['EXIF', 'XMP '])
// A VP8X chunk's flags saying the file holds EXIF and XMP chunks.
const WEBP_METADATA_FLAGS = 0x08 | 0x04
const ICC = 'ICC_PROFILE\0'
const EXIF = 'Exif\0\0'
const ORIENTATION_TAG = 0x0112

// The image without its metadata, or the bytes as they came for a format it does not read or a file it cannot follow.
export function stripImageMetadata(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  try {
    if (startsWith(bytes, JPEG))
      return stripJpeg(bytes)

    if (startsWith(bytes, PNG))
      return stripPng(bytes)

    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP')
      return stripWebp(bytes)
  }
  catch {}

  return bytes
}

// Keeps the segments that shape the picture, an Adobe APP14 and an ICC profile among them, and drops EXIF, XMP, IPTC, comments and the pictures appended after the image's end.
function stripJpeg(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const parts: Uint8Array[] = [bytes.subarray(0, 2)]
  let orientationKept = false
  let at = 2

  while (at < bytes.length) {
    if (bytes[at] !== 0xFF)
      throw new Error('not a marker')

    const marker = bytes[at + 1]!

    if (marker === 0xFF) {
      at++

      continue
    }

    if (marker === 0xD9) {
      parts.push(bytes.subarray(at, at + 2))

      break
    }

    // Markers that carry no length.
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      parts.push(bytes.subarray(at, at + 2))
      at += 2

      continue
    }

    const end = at + 2 + view.getUint16(at + 2)
    const payload = bytes.subarray(at + 4, end)

    if (marker === 0xDA) {
      const scanned = scanEnd(bytes, end)

      parts.push(bytes.subarray(at, scanned))
      at = scanned

      continue
    }

    if (marker === 0xE1 && ascii(payload, 0, EXIF.length) === EXIF && !orientationKept) {
      const orientation = exifOrientation(payload.subarray(EXIF.length))

      orientationKept = true

      if (orientation !== undefined && orientation !== 1)
        parts.push(orientationSegment(orientation))
    }
    // A comment, EXIF or XMP, IPTC, and an APP2 other than the colour profile, such as the index of appended pictures, are dropped.
    else if (marker !== 0xFE && marker !== 0xE1 && marker !== 0xED && (marker !== 0xE2 || ascii(payload, 0, ICC.length) === ICC)) {
      parts.push(bytes.subarray(at, end))
    }

    at = end
  }

  return concat(parts)
}

// Where a scan's entropy-coded data ends: at the first marker that is neither a stuffed 0xFF nor a restart.
function scanEnd(bytes: Uint8Array, from: number): number {
  for (let at = from; at + 1 < bytes.length; at++) {
    const next = bytes[at + 1]!

    if (bytes[at] === 0xFF && next !== 0x00 && (next < 0xD0 || next > 0xD7))
      return at
  }

  return bytes.length
}

// An EXIF it cannot follow says nothing, so the picture keeps its pixels as they are stored.
function exifOrientation(tiff: Uint8Array): number | undefined {
  try {
    return tiffOrientation(tiff)
  }
  catch {
    return undefined
  }
}

function tiffOrientation(tiff: Uint8Array): number | undefined {
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength)
  const little = ascii(tiff, 0, 2) === 'II'
  const ifd = view.getUint32(4, little)
  const count = view.getUint16(ifd, little)

  for (let entry = ifd + 2; entry < ifd + 2 + count * 12; entry += 12) {
    if (view.getUint16(entry, little) === ORIENTATION_TAG)
      return view.getUint16(entry + 8, little)
  }

  return undefined
}

// An APP1 holding an EXIF with the orientation alone, big-endian.
function orientationSegment(orientation: number): Uint8Array {
  const segment = new Uint8Array(36)
  const view = new DataView(segment.buffer)

  view.setUint16(0, 0xFFE1)
  view.setUint16(2, 34)
  segment.set(new TextEncoder().encode(`${EXIF}MM`), 4)
  view.setUint16(12, 42)
  view.setUint32(14, 8)
  view.setUint16(18, 1)
  view.setUint16(20, ORIENTATION_TAG)
  view.setUint16(22, 3)
  view.setUint32(24, 1)
  view.setUint16(28, orientation)

  return segment
}

function stripPng(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const parts: Uint8Array[] = [bytes.subarray(0, PNG.length)]

  for (let at = PNG.length; at < bytes.length;) {
    const end = at + 12 + view.getUint32(at)
    const type = ascii(bytes, at + 4, 4)

    if (end > bytes.length)
      throw new Error('cut short')

    if (!PNG_DROPPED.has(type))
      parts.push(bytes.subarray(at, end))

    if (type === 'IEND')
      break

    at = end
  }

  return concat(parts)
}

function stripWebp(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const parts: Uint8Array[] = [bytes.slice(0, 12)]
  const riffEnd = Math.min(bytes.length, 8 + view.getUint32(4, true))

  for (let at = 12; at + 8 <= riffEnd;) {
    const size = view.getUint32(at + 4, true)
    const end = at + 8 + size + (size % 2)
    const type = ascii(bytes, at, 4)

    if (end > riffEnd)
      throw new Error('cut short')

    if (type === 'VP8X') {
      const chunk = bytes.slice(at, end)

      chunk[8]! &= ~WEBP_METADATA_FLAGS
      parts.push(chunk)
    }
    else if (!WEBP_DROPPED.has(type)) {
      parts.push(bytes.subarray(at, end))
    }

    at = end
  }

  const stripped = concat(parts)

  new DataView(stripped.buffer).setUint32(4, stripped.length - 8, true)

  return stripped
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0

  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }

  return joined
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte)
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length))
}
