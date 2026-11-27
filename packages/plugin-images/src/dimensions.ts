// Image sizes read from the file header, with no decoder and no process.

/** Pure-JS binary header parser for PNG, GIF, WebP, JPEG, and AVIF/HEIF dimensions (zero external dependencies). */
export function readImageDimensions(bytes: Uint8Array): { width: number, height: number } | undefined {
  const len = bytes.byteLength
  if (len < 10)
    return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, len)

  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width@16, height@20 (uint32BE)
  if (len >= 24 && view.getUint32(0) === 0x89504E47 && view.getUint32(4) === 0x0D0A1A0A) {
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    return width > 0 && height > 0 ? { width, height } : undefined
  }

  // GIF87a / GIF89a: width@6, height@8 (uint16LE)
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    const width = view.getUint16(6, true)
    const height = view.getUint16(8, true)
    return width > 0 && height > 0 ? { width, height } : undefined
  }

  if (len >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250)
    return webpDimensions(bytes, view)
  if (bytes[0] === 0xFF && bytes[1] === 0xD8)
    return jpegDimensions(bytes, view)
  if (len >= 24 && view.getUint32(4) === 0x66747970)
    return isobmffDimensions(bytes, view)
  return undefined
}

/** WebP, RIFF....WEBP: the VP8X, VP8L or VP8 chunk's size. */
function webpDimensions(bytes: Uint8Array, view: DataView): { width: number, height: number } | undefined {
  const len = bytes.byteLength
  const chunk = view.getUint32(12)
  // VP8X extended
  if (chunk === 0x56503858) {
    const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16))
    const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16))
    return { width, height }
  }
  // VP8L lossless
  if (chunk === 0x5650384C && len >= 25 && bytes[20] === 0x2F) {
    const bits = view.getUint32(21, true)
    return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 }
  }
  // VP8 lossy
  if (chunk === 0x56503820 && bytes[23] === 0x9D && bytes[24] === 0x01 && bytes[25] === 0x2A) {
    const width = view.getUint16(26, true) & 0x3FFF
    const height = view.getUint16(28, true) & 0x3FFF
    return width > 0 && height > 0 ? { width, height } : undefined
  }
  return undefined
}

/** AVIF / HEIF (ISOBMFF): ftyp, then meta -> iprp -> ipco -> the 'ispe' full box, its version and flags then uint32BE width and height. */
function isobmffDimensions(bytes: Uint8Array, view: DataView): { width: number, height: number } | undefined {
  for (let i = 12; i + 16 <= bytes.byteLength; i++) {
    if (bytes[i] === 0x69 && bytes[i + 1] === 0x73 && bytes[i + 2] === 0x70 && bytes[i + 3] === 0x65) {
      const width = view.getUint32(i + 8)
      const height = view.getUint32(i + 12)
      if (width > 0 && height > 0 && width <= 65535 && height <= 65535)
        return { width, height }
    }
  }
  return undefined
}

/**
 * A JPEG's size as it is displayed: FF D8 then markers, SOF0..SOF15 (except C4, C8, CC) carrying height@+5 and width@+7,
 * turned a quarter when an earlier Exif segment's Orientation is 5 to 8, as `magick -auto-orient` and browsers turn it.
 */
function jpegDimensions(bytes: Uint8Array, view: DataView): { width: number, height: number } | undefined {
  const len = bytes.byteLength
  let orientation = 1
  let offset = 2
  while (offset + 4 <= len) {
    if (bytes[offset] !== 0xFF)
      return undefined
    while (offset < len && bytes[offset] === 0xFF) offset++
    if (offset >= len)
      return undefined
    const marker = bytes[offset++]!
    if (marker === 0xD9 || marker === 0xDA)
      return undefined
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7))
      continue
    if (offset + 2 > len)
      return undefined
    const segLen = view.getUint16(offset)
    if (segLen < 2 || offset + segLen > len)
      return undefined
    if (marker === 0xE1 && orientation === 1)
      orientation = exifOrientation(view, offset + 2, offset + segLen)
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC && segLen >= 7) {
      const height = view.getUint16(offset + 3)
      const width = view.getUint16(offset + 5)
      if (width === 0 || height === 0)
        return undefined
      return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height }
    }
    offset += segLen
  }
  return undefined
}

/** The Orientation tag (0x0112) of an APP1 segment's first IFD, or 1 when it is no Exif segment, has none or is cut short. */
function exifOrientation(view: DataView, start: number, end: number): number {
  // "Exif\0\0", then a TIFF header: II or MM, 42, the offset of the first IFD.
  if (end - start < 14 || view.getUint32(start) !== 0x45786966 || view.getUint16(start + 4) !== 0)
    return 1
  const tiff = start + 6
  const order = view.getUint16(tiff)
  if (order !== 0x4949 && order !== 0x4D4D)
    return 1
  const little = order === 0x4949
  const ifd = tiff + view.getUint32(tiff + 4, little)
  if (ifd + 2 > end)
    return 1
  const count = view.getUint16(ifd, little)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end)
      return 1
    if (view.getUint16(entry, little) === 0x0112)
      return view.getUint16(entry + 8, little)
  }
  return 1
}
