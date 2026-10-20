import { spyOn } from 'bun:test'

// Counts the images decoded for their color: the only decode that shrinks an image to 32 by 32 pixels.
export function countColorReads(): { count: () => number, restore: () => void } {
  const resize = spyOn(Bun.Image.prototype, 'resize')

  return { count: () => resize.mock.calls.filter(([width, height]) => width === 32 && height === 32).length, restore: () => resize.mockRestore() }
}
