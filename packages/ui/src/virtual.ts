import { memo, signal } from 'kay'

// The height assumed for the scroll box until it is measured, so the server and the first browser render draw the same rows.
export const INITIAL_VIEWPORT = 640

// Where each of `count` rows starts, and the total height last: the running sum of `sizeAt`.
export function offsetsOf(count: number, sizeAt: (index: number) => number): Float64Array {
  const offsets = new Float64Array(count + 1)

  for (let index = 0; index < count; index++)
    offsets[index + 1] = offsets[index]! + sizeAt(index)

  return offsets
}

// The rows `start` up to `end` (excluded) that a box scrolled to `top` and `viewport` tall shows, with `overscan` more on each side.
export function windowOf(offsets: Float64Array, top: number, viewport: number, overscan: number): { start: number, end: number } {
  const count = offsets.length - 1

  if (count === 0)
    return { start: 0, end: 0 }

  // The first row ending below `edge`.
  const search = (edge: number) => {
    let low = 0
    let high = count

    while (low < high) {
      const middle = (low + high) >> 1

      if (offsets[middle + 1]! > edge)
        high = middle
      else
        low = middle + 1
    }

    return low
  }
  const first = Math.min(search(Math.max(0, top)), count - 1)
  const bottom = search(Math.max(0, top) + viewport)
  // A row starting right at the bottom edge is out of view.
  const last = Math.max(first + 1, offsets[bottom]! >= Math.max(0, top) + viewport ? bottom : bottom + 1)

  return { start: Math.max(0, first - overscan), end: Math.min(count, last + overscan) }
}

export interface VirtualOptions<Item> {
  items: () => Item[]
  // Tells a row from another, so a measured height follows its row when the list shifts.
  keyOf: (item: Item, index: number) => unknown
  // The height of a row not measured yet, in pixels.
  estimate: number
  overscan: number
}

// The rows a scroll box shows out of a long list and the room above and below them standing for the others. Heights start as `estimate` and become what the rendered rows measure, so a list of rows of any height scrolls to the right length.
export function virtualRows<Item>(options: VirtualOptions<Item>) {
  const { items, keyOf, estimate, overscan } = options
  const heights = new Map<unknown, number>()
  const version = signal(0)
  const top = signal(0)
  const viewport = signal(INITIAL_VIEWPORT)

  const offsets = memo(() => {
    const list = items()

    version()

    // Heights of rows that left the list are dropped once they outnumber the list, so a list replaced again and again does not grow the map.
    if (heights.size > list.length * 2 + 100) {
      const present = new Set(list.map(keyOf))

      for (const key of heights.keys()) {
        if (!present.has(key))
          heights.delete(key)
      }
    }

    return offsetsOf(list.length, index => heights.get(keyOf(list[index]!, index)) ?? estimate)
  })
  const range = memo(() => windowOf(offsets(), top(), viewport(), overscan), { equals: (a, b) => a.start === b.start && a.end === b.end })
  const rows = memo(() => items().slice(range().start, range().end))
  // The room standing for the rows above the window and for those below it.
  const before = memo(() => offsets()[range().start]!)
  const after = memo(() => offsets().at(-1)! - offsets()[range().end]!)

  // Follows `box`'s scroll and size and measures the rows `content` holds, each marked `data-virtual-index`, as they come and resize. Returns what stops it.
  function attach(box: HTMLElement, content: HTMLElement): () => void {
    const sync = () => {
      top.set(box.scrollTop)

      if (box.clientHeight > 0)
        viewport.set(box.clientHeight)
    }

    const resize = new ResizeObserver((entries) => {
      let changed = false

      for (const entry of entries) {
        if (entry.target === box) {
          sync()

          continue
        }

        const index = Number((entry.target as HTMLElement).dataset.virtualIndex)
        const item = items()[index]
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height

        if (item === undefined || !(height > 0))
          continue

        const key = keyOf(item, index)

        if (heights.get(key) !== height) {
          heights.set(key, height)
          changed = true
        }
      }

      if (changed)
        version.set(version() + 1)
    })
    const watch = (node: Node) => {
      if (node instanceof HTMLElement && node.dataset.virtualIndex !== undefined)
        resize.observe(node)
    }
    const added = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof HTMLElement)
            resize.unobserve(node)
        }

        for (const node of record.addedNodes)
          watch(node)
      }
    })

    box.addEventListener('scroll', sync, { passive: true })
    resize.observe(box)
    for (const node of content.childNodes)
      watch(node)
    added.observe(content, { childList: true })
    sync()

    return () => {
      box.removeEventListener('scroll', sync)
      resize.disconnect()
      added.disconnect()
    }
  }

  return { rows, start: () => range().start, before, after, count: () => items().length, attach }
}
