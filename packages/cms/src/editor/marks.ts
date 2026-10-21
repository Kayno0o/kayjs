import type { MarkedField } from '../markers'
import { allMarked, markedBox } from '../markers'
import { isTypingInline } from './inline'

// The outlines drawn over the page's marked fields in edit mode: the field under the pointer, and with `all` every field at once. They sit in a layer of their own, so an attribute or a comment pair, which no CSS selector reaches, is outlined as an element is, and the page's own markup stays as it is.
export interface Marks {
  // The fields under the pointer, none to clear them.
  hover: (fields: MarkedField[] | undefined) => void
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

export function createMarks(all: boolean): Marks {
  const layer = document.createElement('div')
  const follow = new AbortController()
  let hovered: MarkedField[] = []
  let frame = 0

  layer.className = 'kcms-marks'
  layer.setAttribute('aria-hidden', 'true')
  document.body.append(layer)

  const draw = () => {
    frame = 0

    const boxes: HTMLElement[] = []
    const add = (field: MarkedField, isHovered: boolean) => {
      const box = markedBox(field)

      if (!box || box.bottom < 0 || box.right < 0 || box.top > innerHeight || box.left > innerWidth)
        return

      const mark = document.createElement('div')

      mark.className = 'kcms-mark'
      mark.toggleAttribute('data-hover', isHovered)
      mark.style.cssText = `left:${box.left - GROW}px;top:${box.top - GROW}px;width:${box.width + GROW * 2}px;height:${box.height + GROW * 2}px`
      boxes.push(mark)
    }

    if (all) {
      for (const field of allMarked())
        add(field, false)
    }

    for (const field of hovered)
      add(field, true)

    layer.replaceChildren(...boxes)
  }
  const redraw = () => {
    if (frame === 0)
      frame = requestAnimationFrame(draw)
  }
  // The text being typed in changes on every keystroke, which moves no outline worth drawing again.
  const observer = new MutationObserver((records) => {
    if (records.some(record => !isTypingInline(record.target) && !layer.contains(record.target) && !(record.target.parentElement ?? record.target as Element).closest?.('.kcms-editor')))
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
      const next = fields ?? []

      if (next.length === hovered.length && next.every((field, index) => field.element === hovered[index]?.element && field.start === hovered[index]?.start && field.attribute === hovered[index]?.attribute))
        return

      hovered = next
      redraw()
    },
    destroy() {
      follow.abort()
      observer.disconnect()
      cancelAnimationFrame(frame)
      layer.remove()
    },
  }
}
