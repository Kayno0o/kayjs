import type { MarkedField } from '../markers'
import { allMarked, markedBox } from '../markers'
import { isTypingInline } from './inline'

// The outlines drawn over the page's marked fields in edit mode: the field under the pointer, and with `all` every field at once. They sit in a layer of their own, so an attribute or a comment pair, which no CSS selector reaches, is outlined as an element is, and the page's own markup stays as it is.
export interface Marks {
  // The fields under the pointer, none to clear them.
  hover: (fields: MarkedField[] | undefined) => void
  // The fields of the element holding the keyboard focus.
  focus: (fields: MarkedField[] | undefined) => void
  destroy: () => void
}

const KEY = 'kcms-marks'
const GROW = 2

export function readMarking(storage: Pick<Storage, 'getItem'> | undefined): boolean | undefined {
  try {
    const read = storage?.getItem(KEY)

    return read === 'on' || read === 'off' ? read === 'on' : undefined
  }
  catch {
    return undefined
  }
}

export function writeMarking(storage: Pick<Storage, 'setItem'> | undefined, on: boolean): void {
  try {
    storage?.setItem(KEY, on ? 'on' : 'off')
  }
  catch {}
}

function same(next: MarkedField[], current: MarkedField[]): boolean {
  return next.length === current.length && next.every((field, index) => field.element === current[index]?.element && field.start === current[index]?.start && field.attribute === current[index]?.attribute)
}

export function createMarks(all: boolean): Marks {
  const layer = document.createElement('div')
  const follow = new AbortController()
  let hovered: MarkedField[] = []
  let focused: MarkedField[] = []
  // The marked fields of the page, walked again only once the page's elements or markers changed, not on a scroll.
  let known: MarkedField[] | undefined
  let frame = 0

  layer.className = 'kcms-marks'
  layer.setAttribute('aria-hidden', 'true')
  document.body.append(layer)

  const draw = () => {
    frame = 0

    // A page swap takes the layer away with the rest of the body it does not hold.
    if (!layer.isConnected)
      document.body.append(layer)

    const boxes: HTMLElement[] = []
    const add = (field: MarkedField, state?: 'hover' | 'focus') => {
      const box = markedBox(field)

      if (!box || box.bottom < 0 || box.right < 0 || box.top > innerHeight || box.left > innerWidth)
        return

      const mark = document.createElement('div')

      mark.className = 'kcms-mark'

      if (state)
        mark.setAttribute(`data-${state}`, '')

      mark.style.cssText = `left:${box.left - GROW}px;top:${box.top - GROW}px;width:${box.width + GROW * 2}px;height:${box.height + GROW * 2}px`
      boxes.push(mark)
    }

    if (all) {
      known ??= allMarked()

      for (const field of known)
        add(field)
    }

    for (const field of focused)
      add(field, 'focus')

    for (const field of hovered)
      add(field, 'hover')

    layer.replaceChildren(...boxes)
  }
  const redraw = () => {
    if (frame === 0)
      frame = requestAnimationFrame(draw)
  }
  // The text being typed in changes on every keystroke, which moves no outline worth drawing again.
  const observer = new MutationObserver((records) => {
    let changed = false

    for (const record of records) {
      const element = record.target instanceof Element ? record.target : record.target.parentElement

      if (isTypingInline(record.target) || layer.contains(record.target) || element?.closest('.kcms-editor'))
        continue

      changed = true

      if (record.type === 'childList' || record.attributeName?.startsWith('data-kay-'))
        known = undefined
    }

    if (changed)
      redraw()
  })

  addEventListener('scroll', redraw, { capture: true, passive: true, signal: follow.signal })
  addEventListener('resize', redraw, { passive: true, signal: follow.signal })

  if (all) {
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
    redraw()
  }

  return {
    hover(fields) {
      if (!same(fields ?? [], hovered))
        redraw()

      hovered = fields ?? []
    },
    focus(fields) {
      if (!same(fields ?? [], focused))
        redraw()

      focused = fields ?? []
    },
    destroy() {
      follow.abort()
      observer.disconnect()
      cancelAnimationFrame(frame)
      layer.remove()
    },
  }
}
