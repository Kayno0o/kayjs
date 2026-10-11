export interface MasonryPlace {
  lane: number
  // From the top of the layout, in pixels.
  top: number
}

export interface MasonryLayout {
  places: MasonryPlace[]
  height: number
}

// How much shorter a lane further right has to be before a tile skips the leftmost near-shortest one, so the order still reads left to right.
export const MASONRY_TOLERANCE = 16

// How many lanes at least `minWidth` wide fit in `width`, `gap` apart; the count a CSS grid's `auto-fill` makes of the same tracks.
export function laneCount(width: number, minWidth: number, gap: number): number {
  return Math.max(1, Math.floor((width + gap) / (minWidth + gap)))
}

// Each tile dropped in turn into the shortest lane, the leftmost one within `tolerance` of it; a tile not measured yet takes no room.
export function masonryLayout(heights: readonly (number | undefined)[], lanes: number, gap: number, tolerance = MASONRY_TOLERANCE): MasonryLayout {
  const bottoms = Array.from<number>({ length: Math.max(1, lanes) }).fill(0)

  const places = heights.map((height) => {
    const shortest = Math.min(...bottoms)
    const lane = bottoms.findIndex(bottom => bottom <= shortest + tolerance)
    const top = bottoms[lane]!

    if (height !== undefined)
      bottoms[lane] = top + height + gap

    return { lane, top }
  })

  return { places, height: Math.max(0, Math.max(...bottoms) - gap) }
}
