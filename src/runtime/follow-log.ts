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
    let height = 0
    let viewport = 0
    let position = 0
    let anchor: Anchor | undefined

    // Instant, so a container with `scroll-behavior: smooth` is not measured halfway.
    const scrollTo = (top: number): void => element.scrollTo({ top, behavior: 'instant' })

    const items = (): Element[] => options.items === undefined ? [...element.children] : [...element.querySelectorAll(options.items)]

    // Against the sizes measured last, so only the reader's scrolling can end the following, never the container shrinking.
    const away = (): number => height - element.scrollTop - viewport

    const measure = (): void => {
      height = element.scrollHeight
      viewport = element.clientHeight
      position = element.scrollTop
      following = away() <= threshold
      anchor = undefined

      if (following)
        return

      const top = element.getBoundingClientRect().top
      const item = items().find(each => each.getBoundingClientRect().bottom > top)

      anchor = item && { item, offset: item.getBoundingClientRect().top - top }
    }

    const settle = (): void => {
      // A scroll event comes a frame after the reader's wheel, so what the reader did since the last measure is read from the scroll position against the height measured then.
      const wasFollowing = following && away() <= threshold

      if (wasFollowing) {
        scrollTo(element.scrollHeight)
      }
      else if (anchor?.item.isConnected) {
        scrollTo(element.scrollTop + anchor.item.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset)
      }

      measure()
    }

    // A scroll event arrives a frame late: when the position is still the one measured, it is our own scroll and a size change since is settled, not read as the reader leaving the bottom.
    const scrolled = (): void => {
      if (element.scrollTop === position && (element.scrollHeight !== height || element.clientHeight !== viewport))
        settle()
      else
        measure()
    }

    const resizes = new ResizeObserver(settle)

    // A line growing without a change to the DOM, as an image or a font loading does, resizes its item.
    const watch = (node: Node): void => {
      if (node instanceof Element && (options.items === undefined ? node.parentElement === element : node.matches(options.items)))
        resizes.observe(node)
    }

    const changes = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes)
          watch(node)
      }

      settle()
    })

    for (const item of items())
      watch(item)

    scrollTo(element.scrollHeight)
    measure()
    element.addEventListener('scroll', scrolled, { passive: true })
    changes.observe(element, { childList: true, subtree: true, characterData: true })
    resizes.observe(element)
    onCleanup(() => {
      element.removeEventListener('scroll', scrolled)
      changes.disconnect()
      resizes.disconnect()
    })
  })
}
