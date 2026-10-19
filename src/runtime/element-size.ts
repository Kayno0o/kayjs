import { effect, onCleanup, ownSignal } from './reactive'

export interface ElementSize {
  // The element to measure, as `ref={size.ref}`.
  ref: (element: Element) => void
  // The content box's width in pixels, 0 until the element is measured and on the server.
  width: () => number
  // The content box's height in pixels, 0 until the element is measured and on the server.
  height: () => number
}

// An element's width and height as reactive values, observed for as long as the island lives: `const column = elementSize()`, then `ref={column.ref}` and `column.width()`.
export function elementSize(): ElementSize {
  const [element, setElement] = ownSignal<Element | undefined>(undefined)
  const [width, setWidth] = ownSignal(0)
  const [height, setHeight] = ownSignal(0)

  effect(() => {
    const observed = element()

    if (!observed || typeof ResizeObserver === 'undefined')
      return

    const observer = new ResizeObserver((entries) => {
      const { contentRect } = entries.at(-1)!

      setWidth(contentRect.width)
      setHeight(contentRect.height)
    })

    observer.observe(observed)
    onCleanup(() => observer.disconnect())
  })

  return { ref: setElement, width, height }
}
