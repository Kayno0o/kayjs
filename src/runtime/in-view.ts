import { onCleanup, ownSignal } from './reactive'

export interface InViewOptions {
  // How much of the element must show for it to count as in view, from 0 to 1 or a list of thresholds; 0 by default, any pixel.
  threshold?: number | number[]
  // A margin around the viewport, as CSS margins: `'200px'` counts an element 200 px before it enters the screen.
  margin?: string
  // The scrolling element the element is watched in; the viewport by default.
  root?: Element | null
  // Stop watching, and stay `true`, once the element has been in view: for an image or an animation that starts once.
  once?: boolean
}

export interface InView {
  // The element to watch, as `ref={seen.ref}`; several elements are in view while any of them is.
  ref: (element: Element) => () => void
  // Whether an element shows in the viewport, `false` until the browser has reported and on the server.
  visible: () => boolean
}

// Whether an element shows in the viewport, as a value that follows its scrolling for as long as it is rendered: `const seen = inView()`, then `ref={seen.ref}` and `seen.visible()`.
// An element removed by an `if` is let go, and `visible` ignores it from then on.
// kept: free
export function inView(options: InViewOptions = {}): InView {
  const [visible, setVisible] = ownSignal(false)
  const showing = new Set<Element>()
  // How many times each element was given to `ref` and not yet let go, so a report queued for a removed element is ignored.
  const given = new Map<Element, number>()
  let observer: IntersectionObserver | undefined
  let seen = false

  const publish = () => setVisible(showing.size > 0 || (options.once === true && seen))

  onCleanup(() => observer?.disconnect())

  function ref(element: Element): () => void {
    if (typeof IntersectionObserver === 'undefined')
      return () => undefined

    if (!observer) {
      const init: IntersectionObserverInit = { root: options.root ?? null }

      if (options.margin !== undefined)
        init.rootMargin = options.margin

      if (options.threshold !== undefined)
        init.threshold = options.threshold

      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!given.has(entry.target))
            continue

          if (entry.isIntersecting)
            showing.add(entry.target)
          else
            showing.delete(entry.target)
        }

        seen ||= showing.size > 0
        publish()

        if (options.once && seen)
          observer?.disconnect()
      }, init)
    }

    given.set(element, (given.get(element) ?? 0) + 1)

    if (!(options.once && seen))
      observer.observe(element)

    return () => {
      const left = (given.get(element) ?? 1) - 1

      if (left > 0) {
        given.set(element, left)

        return
      }

      given.delete(element)
      observer?.unobserve(element)

      if (showing.delete(element))
        publish()
    }
  }

  return { ref, visible }
}
