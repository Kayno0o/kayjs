import { describe, expect, it } from 'bun:test'
import { stripImageMetadata } from '../src/server/image-metadata'

const GPS = 'GPS 48.8584 N 2.2945 E'

function bytesOf(...parts: (Uint8Array | string | number[])[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(parts.flatMap(part => typeof part === 'string' ? [...new TextEncoder().encode(part)] : [...part]))
}

function u16(value: number, little = false): number[] {
  return little ? [value & 0xFF, value >> 8] : [value >> 8, value & 0xFF]
}

function u32(value: number, little = false): number[] {
  const big = [value >>> 24, (value >>> 16) & 0xFF, (value >>> 8) & 0xFF, value & 0xFF]

  return little ? big.toReversed() : big
}

function holds(bytes: Uint8Array, text: string): boolean {
  return new TextDecoder('latin1').decode(bytes).includes(text)
}

// An EXIF of a little-endian camera: its orientation, then a string standing in for the GPS block.
function exifSegment(orientation: number): Uint8Array {
  const tiff = bytesOf('II', u16(42, true), u32(8, true), u16(2, true), u16(0x0112, true), u16(3, true), u32(1, true), u16(orientation, true), [0, 0], u16(0x8825, true), u16(4, true), u32(1, true), u32(38, true), u32(0, true), GPS)
  const payload = bytesOf('Exif\0\0', tiff)

  return bytesOf([0xFF, 0xE1], u16(payload.length + 2), payload)
}

function segment(marker: number, payload: string): Uint8Array {
  return bytesOf([0xFF, marker], u16(payload.length + 2), payload)
}

describe('stripImageMetadata', () => {
  it('drops a JPEG\'s EXIF, XMP, comments and appended pictures, keeping its orientation, colour profile and pixels', async () => {
    const jpeg = await new Bun.Image(await Bun.file('tests/fixtures/images/src/hero.png').bytes()).resize(40, 24).jpeg().bytes()
    const tagged = bytesOf(jpeg.subarray(0, 2), exifSegment(6), segment(0xE1, `http://ns.adobe.com/xap/1.0/\0${GPS}`), segment(0xE2, 'ICC_PROFILE\0profile'), segment(0xE2, `MPF\0${GPS}`), segment(0xFE, GPS), jpeg.subarray(2), [0xFF, 0xD8], GPS)
    const stripped = stripImageMetadata(tagged)

    expect(holds(tagged, GPS)).toBe(true)
    expect(holds(stripped, GPS)).toBe(false)
    expect(holds(stripped, 'ICC_PROFILE')).toBe(true)
    expect(holds(stripped, 'Exif')).toBe(true)
    // Turned a quarter, as the kept orientation says.
    expect(await new Bun.Image(stripped).metadata()).toEqual({ width: 24, height: 40, format: 'jpeg' })
    expect(await new Bun.Image(stripped).png().bytes()).toEqual(await new Bun.Image(tagged).png().bytes())
    expect(holds(stripImageMetadata(bytesOf(jpeg.subarray(0, 2), exifSegment(1), jpeg.subarray(2))), 'Exif')).toBe(false)
  })

  it('drops a PNG\'s text, time and EXIF chunks', async () => {
    const png = await Bun.file('tests/fixtures/images/src/hero.png').bytes()
    const chunk = (type: string, data: string) => bytesOf(u32(data.length), type, data, [0, 0, 0, 0])
    // Put after IHDR, which a PNG starts with.
    const tagged = bytesOf(png.subarray(0, 33), chunk('tEXt', `Comment\0${GPS}`), chunk('eXIf', GPS), chunk('tIME', '1234567'), png.subarray(33))
    const stripped = stripImageMetadata(tagged)

    expect(holds(stripped, GPS)).toBe(false)
    expect(holds(stripped, 'tIME')).toBe(false)
    expect(await new Bun.Image(stripped).metadata()).toEqual({ width: 1000, height: 600, format: 'png' })
  })

  it('drops a WebP\'s EXIF and XMP chunks, clearing the flags that announced them', async () => {
    const webp = await new Bun.Image(await Bun.file('tests/fixtures/images/src/hero.png').bytes()).resize(40, 24).webp().bytes()
    const vp8x = bytesOf('VP8X', u32(10, true), [0x08 | 0x04, 0, 0, 0], [39, 0, 0], [23, 0, 0])
    const body = bytesOf('WEBP', vp8x, webp.subarray(12), 'EXIF', u32(GPS.length, true), GPS, 'XMP ', u32(GPS.length, true), GPS)
    const tagged = bytesOf('RIFF', u32(body.length, true), body)
    const stripped = stripImageMetadata(tagged)

    expect(holds(stripped, GPS)).toBe(false)
    expect(stripped[20]).toBe(0)
    expect(new DataView(stripped.buffer).getUint32(4, true)).toBe(stripped.length - 8)
    expect(await new Bun.Image(stripped).metadata()).toEqual({ width: 40, height: 24, format: 'webp' })
  })

  it('leaves alone a format it does not read and a file it cannot follow', () => {
    const gif = bytesOf('GIF89a', GPS)
    const broken = bytesOf([0xFF, 0xD8, 0x00], GPS)

    expect(stripImageMetadata(gif)).toBe(gif)
    expect(stripImageMetadata(broken)).toBe(broken)
  })
})
