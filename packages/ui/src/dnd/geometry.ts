import { clamp } from '@kaynooo/utils/number'

// How near a scroll container's edge the pointer has to be before the drag scrolls it.
const EDGE_PX = 64
// The fastest the container scrolls per frame, reached at the edge itself.
const MAX_SPEED_PX = 22
// The keys that move a focused handle's item, and by how many places.
const KEY_STEPS: Partial<Record<string, number>> = { ArrowUp: -1, ArrowDown: 1 }

// Pixels to scroll this frame for a pointer `distance` away from an edge.
function edgeStep(distance: number): number {
  return distance < EDGE_PX ? Math.ceil((1 - Math.max(0, distance) / EDGE_PX) * MAX_SPEED_PX) : 0
}

// Pixels to scroll this frame for a pointer at `y` over a scroller showing `bounds` of the viewport: positive towards the bottom edge, negative towards the top.
export function edgeScroll(y: number, bounds: { top: number, bottom: number }): number {
  return edgeStep(bounds.bottom - y) - edgeStep(y - bounds.top)
}

// The index the dragged item lands on: how many of the other items have their middle above the pointer.
export function targetIndex(items: readonly { mid: number }[], from: number, y: number): number {
  return items.filter((item, index) => index !== from && item.mid < y).length
}

// How far the item at `index` slides while the item from `from` hovers over `to`: out of the way by `shift`, or not at all.
export function offsetOf(index: number, from: number, to: number, shift: number): number {
  if (index > from && index <= to)
    return -shift

  if (index < from && index >= to)
    return shift

  return 0
}

// Where `key` sends the item at `from` in a list of `count`, held inside the list, or `null` for a key that moves nothing.
export function keyTarget(key: string, from: number, count: number): number | null {
  const step = KEY_STEPS[key]

  return step === undefined ? null : clamp(from + step, 0, count - 1)
}

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Point {
  x: number
  y: number
}

// A vertical insertion bar, in the coordinates of the boxes it was measured from.
export interface Bar {
  left: number
  top: number
  height: number
}

// How far outside a box's edge its insertion bar sits, to land in the gap between two items.
const BAR_OFFSET_PX = 3

function centerOf(box: Box): Point {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }
}

// The index of the box the point sits in vertically, the one nearest by center when several or none do, or -1 without any box.
export function nearestBox(point: Point, boxes: readonly Box[]): number {
  const banded = boxes.map((box, index) => ({ box, index })).filter(({ box }) => point.y >= box.top && point.y <= box.bottom)
  const pool = banded.length > 0 ? banded : boxes.map((box, index) => ({ box, index }))
  let best = -1
  let bestDistance = Infinity

  for (const { box, index } of pool) {
    const center = centerOf(box)
    const distance = (point.x - center.x) ** 2 + (point.y - center.y) ** 2

    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  }

  return best
}

// How many of a wrapping layout's boxes come before the point in reading order: every box on a row above it, and those on its row whose middle it has passed.
export function readingIndex(boxes: readonly Box[], point: Point): number {
  return boxes.filter(box => point.y > box.bottom || (point.y >= box.top && point.x >= centerOf(box).x)).length
}

// The bar marking slot `index` among `boxes`, laid out inside `container`: before the box taking that slot, after the last one, or at the start of an empty container.
export function insertionBar(container: Box, boxes: readonly Box[], index: number): Bar {
  const at = boxes[index]
  const last = boxes.at(-1)

  if (at)
    return { left: at.left - BAR_OFFSET_PX, top: at.top, height: at.bottom - at.top }

  if (last)
    return { left: last.right + BAR_OFFSET_PX, top: last.top, height: last.bottom - last.top }

  return { left: container.left + BAR_OFFSET_PX, top: container.top + BAR_OFFSET_PX, height: Math.max(0, container.bottom - container.top - 2 * BAR_OFFSET_PX) }
}

// Where an arrow key sends the item at `index` of container `container`, given each container's item count: Left and Right within it, Up and Down to the same slot of the container before or after, or `null` for any other key.
export function boardKeyTarget(key: string, container: number, index: number, sizes: readonly number[]): { container: number, index: number } | null {
  switch (key) {
    case 'ArrowLeft':
      return { container, index: Math.max(0, index - 1) }
    case 'ArrowRight':
      return { container, index: Math.min((sizes[container] ?? 1) - 1, index + 1) }
    case 'ArrowUp':
    case 'ArrowDown': {
      const next = clamp(container + (key === 'ArrowUp' ? -1 : 1), 0, sizes.length - 1)

      // In another container the item is not counted yet, so its last slot is the one after every item there.
      return next === container ? { container, index } : { container: next, index: Math.min(index, sizes[next] ?? 0) }
    }
    default:
      return null
  }
}
