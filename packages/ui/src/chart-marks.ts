// What every chart shares for the marks it draws one by one (a column, a bar, a dot, a cell, a point): the mark an app is handed, the active mark it hears of or sets, and the tooltip it draws itself.

import { signal } from 'kay'

// The mark of a chart with one place per label, as a BarChart column or a LineChart point: where it is, its label as the app gave it and each series' value there.
export interface ChartMark {
  index: number
  label: string
  values: (number | null)[]
}

// A Sparkline bar.
export interface SparkMark {
  index: number
  value: number | null
}

// The mark an element stands for: a link when it has an address, else a button when the app listens to presses, else a picture.
export type MarkKind = 'link' | 'button' | 'image'

export function markKind(href: string | undefined, selectable: boolean): MarkKind {
  if (href !== undefined && href !== '')
    return 'link'

  return selectable ? 'button' : 'image'
}

// The marks of a chart a pointer or the keyboard is on, besides the active one the app may set: `active` wins when the app gives it, `null` being none.
export function activeMarks(options: { active: () => number | null | undefined, onActive: () => ((index: number | null) => unknown) | undefined }) {
  const inside = signal<number | null>(null)
  const anchor = signal<{ clientX: number, clientY: number } | null>(null)

  function move(index: number | null) {
    if (inside() === index)
      return

    inside.set(index)
    void options.onActive()?.(index)
  }

  return {
    // The mark to draw as active.
    current: (): number | null => options.active() === undefined ? inside() : options.active() ?? null,
    // Where the mark the pointer or the focus is on sits, top centre, for a tooltip to hang from.
    anchor: () => inside() === null ? null : anchor(),
    // The pointer or the focus came onto a mark; leaving it only clears it while it is still the one entered, as a pointer and the focus can be on two marks.
    enter: (index: number, element: Element) => {
      const box = element.getBoundingClientRect()

      anchor.set({ clientX: box.left + box.width / 2, clientY: box.top })
      move(index)
    },
    leave: (index: number) => {
      if (inside() === index)
        move(null)
    },
  }
}

// The distance kept between a tooltip and the viewport's edges, and between it and the pointer.
const EDGE = 4
const GAP = 12

// The look of a chart's own tooltip, the one LineChart has always drawn.
export const TOOLTIP_LOOK = 'pointer-events-none fixed top-0 left-0 z-50 flex w-max max-w-full flex-col gap-0.5 border-solid border-[length:var(--border-width)] border-border-strong bg-surface-strong px-3 py-2 text-xs'

// Where a chart's own tooltip goes: centred over the pointer and above it, flipped below when the top would be cut off, and shifted to stay inside the viewport on every side.
// Its size is watched, so it is placed from its natural width and never narrowed against an edge.
export function chartTooltip() {
  const size = signal({ width: 0, height: 0, wide: 0, high: 0 })
  let observer: ResizeObserver | undefined

  return {
    place(at: { clientX: number, clientY: number }): string {
      const { width, height, wide, high } = size()
      const hidden = width === 0 ? '; visibility: hidden' : ''
      const above = at.clientY - height - GAP
      const top = above >= EDGE ? above : at.clientY + GAP

      return `translate: ${Math.max(EDGE, Math.min(at.clientX - width / 2, wide - width - EDGE))}px ${Math.max(EDGE, Math.min(top, high - height - EDGE))}px${hidden}`
    },
    watch(element: HTMLElement) {
      observer ??= new ResizeObserver((entries) => {
        const box = entries.at(-1)?.target

        if (!box?.isConnected)
          return

        const { width, height } = box.getBoundingClientRect()

        size.set({ width, height, wide: document.documentElement.clientWidth, high: document.documentElement.clientHeight })
      })
      observer.observe(element)
    },
    stop() {
      observer?.disconnect()
    },
  }
}
