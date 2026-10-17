export const MIN_SIZE = 200
export const MAX_WIDTH = 3840
// Taller than this a page is cut, as a model reads an image of about this size at most.
export const MAX_HEIGHT = 8000

// Refused arguments and a setup that cannot shoot say so in their message, which a command prints as it is.
export class ShotRefused extends Error {}

export function checkSize(name: string, value: number, max: number): number {
  if (!Number.isInteger(value) || value < MIN_SIZE || value > max)
    throw new ShotRefused(`${name} takes a whole number of pixels from ${MIN_SIZE} to ${max}, not ${value}`)

  return value
}
