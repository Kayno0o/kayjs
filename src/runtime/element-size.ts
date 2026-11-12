import { onCleanup, ownSignal } from './reactive'

export interface ElementSize {
  // The element to measure, as `ref={size.ref}`; the size read is the last rendered element's, and the one before it again once that is removed.
  ref: (element: Element) => () => void
  // The content box's width in pixels, 0 until the element is measured and on the server.
  width: () => number
  // The content box's height in pixels, 0 until the element is measured and on the server.
  height: () => number
}

// An element's width and height as reactive values, observed for as long as the element is rendered: `const column = elementSize()`, then `ref={column.ref}` and `column.width()`.
// An element removed by an `if` is let go. With several elements, the size read is the last one's that is still rendered.
// kept: free
export function elementSize(): ElementSize {
  const [width, setWidth] = ownSignal(0)
  const [height, setHeight] = ownSignal(0)
  // The elements in the order they were given, each with the size last measured (none before its first measure).
  const elements = new Map<Element, { width: number, height: number } | undefined>()
  let observer: ResizeObserver | undefined

  const publish = () => {
    const last = [...elements.values()].findLast(size => size !== undefined)

    setWidth(last?.width ?? 0)
    setHeight(last?.height ?? 0)
  }

  onCleanup(() => observer?.disconnect())

  function ref(element: Element): () => void {
    if (typeof ResizeObserver === 'undefined')
      return () => undefined

    observer ??= new ResizeObserver((entries) => {
      for (const { target, contentRect } of entries) {
        if (elements.has(target))
          elements.set(target, { width: contentRect.width, height: contentRect.height })
      }

      publish()
    })

    elements.set(element, undefined)
    observer.observe(element)

    return () => {
      observer?.unobserve(element)
      elements.delete(element)
      publish()
    }
  }

  return { ref, width, height }
}
