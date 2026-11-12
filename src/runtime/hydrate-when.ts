// Starts loading a `visible` island this far before it scrolls into view.
declare const KAY_VISIBLE_MARGIN: string | undefined
declare const KAY_NEAR_MARGIN: string | undefined
const VISIBLE_MARGIN = typeof KAY_VISIBLE_MARGIN === 'undefined' ? '200px' : KAY_VISIBLE_MARGIN
// Fetches a deferred server island about a screen before it scrolls into view, so a visitor never meets the copy standing in for it.
const NEAR_MARGIN = typeof KAY_NEAR_MARGIN === 'undefined' ? '100% 0px' : KAY_NEAR_MARGIN
const IDLE_FALLBACK_MS = 200
const INTERACTIONS = ['pointerdown', 'focusin', 'keydown', 'touchstart']

// `near` is a deferred server island, started a screen early.
export function whenVisible(element: HTMLElement, run: () => Promise<void>, near = false) {
  const margin = near ? NEAR_MARGIN : VISIBLE_MARGIN

  if (typeof IntersectionObserver === 'undefined') {
    void run()

    return
  }

  // The wrapper lays out as `display: contents`, so it has no box of its own to intersect: its markup is watched, or its parent when it has none.
  const targets: Element[] = element.children.length > 0 ? [...element.children] : [element.parentElement ?? element]
  // A target with no box (`display: none`, reported as an empty rectangle at the origin) never intersects, so once none of the markup has one the parent is watched as well.
  const boxless = new Set<Element>()
  let parentWatched = element.children.length === 0

  const observer = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) {
      observer.disconnect()
      void run()

      return
    }

    for (const { target, boundingClientRect: { width, height, top, left } } of entries) {
      if (width === 0 && height === 0 && top === 0 && left === 0)
        boxless.add(target)
      else
        boxless.delete(target)
    }

    const parent = element.parentElement

    if (parentWatched || parent === null || targets.some(target => !boxless.has(target)))
      return

    parentWatched = true
    observer.observe(parent)
  }, { rootMargin: margin })

  for (const target of targets)
    observer.observe(target)
}

export function whenIdle(run: () => Promise<void>) {
  if (typeof requestIdleCallback === 'function')
    requestIdleCallback(() => void run())
  else
    setTimeout(() => void run(), IDLE_FALLBACK_MS)
}

// `hydrate="media(...)"`: now when the query matches, else the first time it does. A bare feature, `max-width: 40rem`, is no query to the browser (`media` reads `not all`), so it is tried in brackets.
export function whenMedia(query: string, run: () => Promise<void>) {
  if (typeof matchMedia !== 'function') {
    void run()

    return
  }

  let list = matchMedia(query)

  if (list.media === 'not all')
    list = matchMedia(`(${query})`)

  // A query the browser cannot read would never match, leaving the island dead: it hydrates at once instead.
  if (list.matches || list.media === 'not all') {
    void run()

    return
  }

  const onChange = () => {
    if (!list.matches)
      return

    list.removeEventListener('change', onChange)
    void run()
  }

  list.addEventListener('change', onChange)
}

// `hydrate="interaction"`: on the first pointer, focus, key or touch event inside the island. The click that follows is queued by the page's inline script and replayed once the island is in.
export function whenInteraction(element: HTMLElement, run: () => Promise<void>) {
  const start = () => {
    for (const type of INTERACTIONS)
      element.removeEventListener(type, start, true)

    void run()
  }

  for (const type of INTERACTIONS)
    element.addEventListener(type, start, { capture: true, passive: true })
}
