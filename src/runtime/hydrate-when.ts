// Starts loading a `visible` island this far before it scrolls into view.
declare const KAY_VISIBLE_MARGIN: string | undefined
declare const KAY_NEAR_MARGIN: string | undefined
const VISIBLE_MARGIN = typeof KAY_VISIBLE_MARGIN === 'undefined' ? '200px' : KAY_VISIBLE_MARGIN
// Fetches a deferred server island about a screen before it scrolls into view, so a visitor never meets the copy standing in for it.
const NEAR_MARGIN = typeof KAY_NEAR_MARGIN === 'undefined' ? '100% 0px' : KAY_NEAR_MARGIN
const IDLE_FALLBACK_MS = 200

// `near` is a deferred server island, started a screen early.
export function whenVisible(element: HTMLElement, run: () => Promise<void>, near = false) {
  const margin = near ? NEAR_MARGIN : VISIBLE_MARGIN

  if (typeof IntersectionObserver === 'undefined') {
    void run()

    return
  }

  const observer = new IntersectionObserver((entries) => {
    if (!entries.some(entry => entry.isIntersecting))
      return

    observer.disconnect()
    void run()
  }, { rootMargin: margin })

  // The wrapper lays out as `display: contents`, so it has no box of its own to intersect.
  const targets = element.children.length > 0 ? element.children : [element.parentElement ?? element]

  for (const target of targets)
    observer.observe(target)
}

export function whenIdle(run: () => Promise<void>) {
  if (typeof requestIdleCallback === 'function')
    requestIdleCallback(() => void run())
  else
    setTimeout(() => void run(), IDLE_FALLBACK_MS)
}
