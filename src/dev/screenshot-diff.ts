import { decodePng, encodePng } from '../server/png'

// A channel moving by no more than this is anti-aliasing noise, not a change.
const TOLERANCE = 8
// How much of an unchanged pixel a diff image keeps, so that the changed ones stand out.
const FADE = 0.35

export interface PngDiff {
  // The pixels that differ, those outside the smaller of the two images included.
  changed: number
  // `changed` over the pixels of the larger image.
  ratio: number
  // The smallest rectangle holding every changed pixel.
  box?: { x: number, y: number, width: number, height: number } | undefined
  // The new image faded, its changed pixels red.
  image: Uint8Array
}

// Compares two PNGs on the canvas of the larger.
export async function diffPngs(before: Uint8Array, after: Uint8Array): Promise<PngDiff> {
  const old = decodePng(await uncompressed(before))
  const next = decodePng(await uncompressed(after))
  const width = Math.max(old.width, next.width)
  const height = Math.max(old.height, next.height)
  const out = new Uint8Array(width * height * 4)
  let changed = 0
  let left = width
  let top = height
  let right = -1
  let bottom = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const was = x < old.width && y < old.height ? (y * old.width + x) * 4 : -1
      const now = x < next.width && y < next.height ? (y * next.width + x) * 4 : -1

      if (differs(old.pixels, was, next.pixels, now)) {
        changed++
        left = Math.min(left, x)
        right = Math.max(right, x)
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
        out.set([255, 0, 0, 255], at)
      }
      else if (now >= 0) {
        for (let channel = 0; channel < 3; channel++)
          out[at + channel] = 255 - (255 - next.pixels[now + channel]!) * FADE

        out[at + 3] = 255
      }
      else {
        out.set([255, 255, 255, 255], at)
      }
    }
  }

  return { changed, ratio: changed / (width * height), box: changed === 0 ? undefined : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }, image: encodePng(out, width, height) }
}

function differs(before: Uint8Array, was: number, after: Uint8Array, now: number): boolean {
  if (was < 0 || now < 0)
    return was !== now

  for (let channel = 0; channel < 4; channel++) {
    if (Math.abs(before[was + channel]! - after[now + channel]!) > TOLERANCE)
      return true
  }

  return false
}

// Chrome's PNG, as the 8-bit RGBA with unfiltered rows `decodePng` reads.
async function uncompressed(png: Uint8Array): Promise<Uint8Array> {
  return new Bun.Image(png).png({ compressionLevel: 0 }).bytes()
}
