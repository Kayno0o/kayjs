import { statSync } from 'node:fs'
import { join } from 'node:path'
import { readCacheEntry, writeCacheEntry } from '../build/cache'
import { decodable } from './image-format'
import { decodePng } from './png'

// An image is shrunk to this many pixels a side for its mean to be read from: the decode costs what the shrinking does, a few milliseconds for a photograph, and a transparent corner survives it.
const SIDE = 32

// The mean color of an image as six hex digits, to show in its place until it loads, or undefined for one with any transparency, which the color would show behind, or one Bun.Image cannot read.
export async function dominantColor(source: Blob | Uint8Array, maxPixels?: number): Promise<string | undefined> {
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

let enabled = true

// Whether the images of Markdown content are read for their color: off with `images.placeholder: false`.
export function imageColors(): boolean {
  return enabled
}

export function setImageColors(on: boolean): void {
  enabled = on
}

// Bumped when the way a color is read changes, so the colors kept on disk are read again.
const ALGORITHM = '1'
// The colors read in this process, by file and stamp, so an image several entries and components use is read once.
const read = new Map<string, Promise<string | undefined>>()

// The color of a file, kept under `cacheDir` while its time and size hold: a build reads each image once, not once per run. Null on disk stands for an image with none.
export async function dominantColorOf(file: string, cacheDir: string | undefined): Promise<string | undefined> {
  const stat = statSync(file, { throwIfNoEntry: false })
  const stamp = `${stat?.mtimeMs}:${stat?.size}`
  const id = `${file}\0${stamp}`
  let found = read.get(id)

  if (!found) {
    found = colorOfFile(file, stamp, cacheDir)
    read.set(id, found)
  }

  return found
}

async function colorOfFile(file: string, stamp: string, cacheDir: string | undefined): Promise<string | undefined> {
  const slot = cacheDir === undefined ? undefined : { file: join(cacheDir, `${Bun.hash(file).toString(36)}-color.json`), key: `${ALGORITHM}\0${stamp}` }
  const kept = slot && await readCacheEntry<string | null>(slot)

  if (kept !== undefined)
    return kept ?? undefined

  const color = await dominantColor(Bun.file(file))

  if (slot)
    await writeCacheEntry(slot, color ?? null)

  return color
}
