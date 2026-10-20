import { decodable } from './image-format'
import { decodePng } from './png'

// An image is shrunk to this many pixels a side for its mean to be read from: the decode costs what the shrinking does, a few milliseconds for a photograph, and a transparent corner survives it.
const SIDE = 32

// The mean color of an image as six hex digits, to show in its place until it loads, or undefined for one with any transparency, which the color would show behind, or one Bun.Image cannot read.
export async function dominantColour(source: Blob | Uint8Array, maxPixels?: number): Promise<string | undefined> {
  try {
    const small = await new Bun.Image(await decodable(source, maxPixels), maxPixels === undefined ? {} : { maxPixels }).resize(SIDE, SIDE, { fit: 'fill' }).png({ compressionLevel: 0 }).bytes()
    const { pixels } = decodePng(small)
    const sums = [0, 0, 0]

    for (let at = 0; at < pixels.length; at += 4) {
      if (pixels[at + 3] !== 255)
        return undefined

      sums[0]! += pixels[at]!
      sums[1]! += pixels[at + 1]!
      sums[2]! += pixels[at + 2]!
    }

    const count = pixels.length / 4

    return sums.map(sum => Math.round(sum / count).toString(16).padStart(2, '0')).join('')
  }
  catch {
    return undefined
  }
}
