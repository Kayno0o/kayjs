import { onCleanup, onMount } from './reactive'

export interface FollowLogOptions {
  // How far from the bottom, in pixels, the view still counts as being at it; 32 by default.
  threshold?: number | undefined
  // The items of the list as a selector inside the container, the first one showing being the one kept in place; its direct children by default.
  items?: string | undefined
}

interface Anchor {
  item: Element
  offset: number
}

const DEFAULT_THRESHOLD = 32

// Keeps a scrolling container at its bottom while the reader is there and the first item showing in place while the reader is above it, whatever changes inside: an item appended, one prepended, a line growing as it streams. The container is the element that scrolls, or a function returning it once the island mounted, as `() => list` for a `ref`'s variable. It starts at its bottom, and does nothing on the server.
export function followLog(container: Element | (() => Element | null | undefined), options: FollowLogOptions = {}): void {
  if (typeof document === 'undefined')
    return

  onMount(() => {
    const element = typeof container === 'function' ? container() : container

    if (!element)
      return

    const threshold = options.threshold ?? DEFAULT_THRESHOLD
    let following = true
    let anchor: Anchor | undefined

    const toBottom = (): void => {
      element.scrollTop = element.scrollHeight
    }

    const items = (): Element[] => options.items === undefined ? [...element.children] : [...element.querySelectorAll(options.items)]

    const measure = (): void => {
      const top = element.getBoundingClientRect().top
      const item = items().find(each => each.getBoundingClientRect().bottom > top)

      following = element.scrollHeight - element.scrollTop - element.clientHeight < threshold
      anchor = item && { item, offset: item.getBoundingClientRect().top - top }
    }

    const settle = (): void => {
      if (following) {
        toBottom()
      }
      else if (anchor?.item.isConnected) {
        element.scrollTop += anchor.item.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset
      }

      measure()
    }

    const changes = new MutationObserver(settle)
    const resizes = new ResizeObserver(settle)

    toBottom()
    measure()
    element.addEventListener('scroll', measure, { passive: true })
    changes.observe(element, { childList: true, subtree: true, characterData: true })
    resizes.observe(element)
    onCleanup(() => {
      element.removeEventListener('scroll', measure)
      changes.disconnect()
      resizes.disconnect()
    })
  })
}
