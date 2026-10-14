import { kayLog } from '../runtime/log'

// What a stored photo says beyond its pixels, such as where and when it was taken and on which camera, taken out on upload. The image's look is kept: its colour profile, and a JPEG's orientation, which Bun.Image and browsers apply.
// Each format keeps what an allow-list names, so a kind of metadata it never heard of goes too.
const JPEG = [0xFF, 0xD8]
const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
// Frames, tables, restart interval and line count, and the hierarchical and arithmetic coding markers, which shape the picture.
const JPEG_KEPT = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCC, 0xCD, 0xCE, 0xCF, 0xDB, 0xDC, 0xDD, 0xDE, 0xDF])
const PNG_KEPT = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'cICP', 'mDCV', 'cLLI', 'sBIT', 'pHYs', 'bKGD', 'hIST', 'acTL', 'fcTL', 'fdAT'])
const WEBP_KEPT = new Set(['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'ICCP'])
// A VP8X chunk's flags saying the file holds EXIF and XMP chunks.
const WEBP_METADATA_FLAGS = 0x08 | 0x04
const ICC = 'ICC_PROFILE\0'
const EXIF = 'Exif\0\0'
const JFIF = 'JFIF\0'
const ADOBE = 'Adobe'
// A JFIF header up to its thumbnail's size, which is set to none.
const JFIF_LENGTH = 16
const ORIENTATION_TAG = 0x0112
// Far past any real image's, so a file of tiny segments costs no more than a few of them.
const MAX_SEGMENTS = 10_000

// The image without its metadata, or the bytes as they came for a format it does not read or a file it cannot follow.
export function stripImageMetadata(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  try {
    if (startsWith(bytes, JPEG))
      return stripJpeg(bytes)

    if (startsWith(bytes, PNG))
      return stripPng(bytes)

    if (isWebp(bytes))
      return stripWebp(bytes)
  }
  catch (error) {
    kayLog('warn', 'an uploaded image could not be read through, so it is stored as it came, its metadata included', error)
  }

  return bytes
}

// Whether the file is a JPEG, a PNG or a WebP, read from its first 12 bytes: the formats whose metadata is taken out.
export function holdsImageMetadata(head: Uint8Array): boolean {
  return startsWith(head, JPEG) || startsWith(head, PNG) || isWebp(head)
}

function isWebp(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP'
}

// The byte ranges of a file kept, adjacent ones copied as one run, and the bytes written in place of others; it refuses a file of more segments than any image holds.
class Kept {
  private readonly parts: Uint8Array[] = []
  private start = 0
  private end = 0
  private segments = 0

  constructor(private readonly bytes: Uint8Array) {}

  segment(): void {
    if (++this.segments > MAX_SEGMENTS)
      throw new Error(`more than ${MAX_SEGMENTS} segments`)
  }

  range(start: number, end: number): void {
    if (start !== this.end)
      this.flush(start)

    this.end = end
  }

  add(part: Uint8Array): void {
    this.flush(this.end)
    this.parts.push(part)
  }

  join(): Uint8Array<ArrayBuffer> {
    this.flush(this.end)

    return concat(this.parts)
  }

  private flush(next: number): void {
    if (this.end > this.start)
      this.parts.push(this.bytes.subarray(this.start, this.end))

    this.start = next
    this.end = next
  }
}

// Keeps the segments that shape the picture, a JFIF header without its thumbnail, an ICC profile, an Adobe APP14 and the orientation, and drops every other, EXIF, XMP, IPTC, C2PA and comments among them, and the pictures appended after the image's end.
function stripJpeg(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kept = new Kept(bytes)
  let orientationKept = false
  let at = 2

  kept.range(0, 2)

  while (at < bytes.length) {
    if (bytes[at] !== 0xFF)
      throw new Error('not a marker')

    const marker = bytes[at + 1]!

    if (marker === 0xFF) {
      at++

      continue
    }

    kept.segment()

    if (marker === 0xD9) {
      kept.range(at, at + 2)

      break
    }

    // Markers that carry no length.
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      kept.range(at, at + 2)
      at += 2

      continue
    }

    const end = at + 2 + view.getUint16(at + 2)
    const payload = bytes.subarray(at + 4, end)

    if (end > bytes.length)
      throw new Error('cut short')

    if (marker === 0xDA) {
      const scanned = scanEnd(bytes, end)

      kept.range(at, scanned)
      at = scanned

      continue
    }

    if (JPEG_KEPT.has(marker) || (marker === 0xE2 && ascii(payload, 0, ICC.length) === ICC) || (marker === 0xEE && ascii(payload, 0, ADOBE.length) === ADOBE)) {
      kept.range(at, end)
    }
    else if (marker === 0xE0 && ascii(payload, 0, JFIF.length) === JFIF && end - at >= JFIF_LENGTH + 2) {
      kept.add(jfifHeader(bytes.subarray(at, at + JFIF_LENGTH + 2)))
    }
    else if (marker === 0xE1 && ascii(payload, 0, EXIF.length) === EXIF && !orientationKept) {
      const orientation = exifOrientation(payload.subarray(EXIF.length))

      orientationKept = true

      if (orientation !== undefined && orientation !== 1)
        kept.add(orientationSegment(orientation))
    }

    at = end
  }

  return kept.join()
}

// The JFIF segment with its thumbnail's width and height set to none, and its thumbnail left out.
function jfifHeader(segment: Uint8Array): Uint8Array {
  const header = segment.slice()

  new DataView(header.buffer).setUint16(2, JFIF_LENGTH)
  header[16] = 0
  header[17] = 0

  return header
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
  const kept = new Kept(bytes)

  kept.range(0, PNG.length)

  for (let at = PNG.length; at < bytes.length;) {
    const end = at + 12 + view.getUint32(at)
    const type = ascii(bytes, at + 4, 4)

    if (end > bytes.length)
      throw new Error('cut short')

    kept.segment()

    if (PNG_KEPT.has(type))
      kept.range(at, end)

    if (type === 'IEND')
      break

    at = end
  }

  return kept.join()
}

function stripWebp(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kept = new Kept(bytes)
  const riffEnd = Math.min(bytes.length, 8 + view.getUint32(4, true))

  kept.add(bytes.slice(0, 12))

  for (let at = 12; at + 8 <= riffEnd;) {
    const size = view.getUint32(at + 4, true)
    const end = at + 8 + size + (size % 2)
    const type = ascii(bytes, at, 4)

    if (end > riffEnd)
      throw new Error('cut short')

    kept.segment()

    if (type === 'VP8X') {
      const chunk = bytes.slice(at, end)

      chunk[8]! &= ~WEBP_METADATA_FLAGS
      kept.add(chunk)
    }
    else if (WEBP_KEPT.has(type)) {
      kept.range(at, end)
    }

    at = end
  }

  const stripped = kept.join()

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
