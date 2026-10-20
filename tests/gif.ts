// A GIF of solid frames, the color index `transparent` left clear if given, one color each from a table of 128, every pixel coded on 8 bits with a clear code before each 100, so writing it takes no LZW table.
export function gif(width: number, height: number, frames: number[], transparent?: number): Uint8Array<ArrayBuffer> {
  const bytes = [...new TextEncoder().encode('GIF89a'), width & 255, width >> 8, height & 255, height >> 8, 0xF6, 0, 0]

  for (let index = 0; index < 128; index++)
    bytes.push(index * 2, 255 - index * 2, 128)

  for (const color of frames) {
    const codes: number[] = []

    for (let pixel = 0; pixel < width * height; pixel++) {
      if (pixel % 100 === 0)
        codes.push(128)

      codes.push(color)
    }

    codes.push(129)
    bytes.push(0x21, 0xF9, 4, transparent === undefined ? 0 : 1, 10, 0, transparent ?? 0, 0, 0x2C, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0, 7)

    for (let at = 0; at < codes.length; at += 255)
      bytes.push(Math.min(255, codes.length - at), ...codes.slice(at, at + 255))

    bytes.push(0)
  }

  bytes.push(0x3B)

  return new Uint8Array(bytes)
}
