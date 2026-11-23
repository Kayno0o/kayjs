// @kayjs/spa client bootstrap: intercepts internal <a> clicks, swaps document.body with View Transitions,
// preserves [data-persist] islands alive, and lets <kay-island> connectedCallback hydrate new islands automatically.

let navigating = false

export async function navigate(url: string, push = true): Promise<void> {
  if (navigating)
    return
  navigating = true
  try {
    const res = await fetch(url, { headers: { 'x-kay-spa': '1' } })
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('text/html')) {
      location.assign(url)
      return
    }

    const html = await res.text()
    const nextDoc = new DOMParser().parseFromString(html, 'text/html')

    const applySwap = () => {
      // Preserve live [data-persist] elements (e.g. persistent audio player or counter island) across navigations
      const persisted = new Map<string, Element>()
      for (const el of document.querySelectorAll('[data-persist]')) {
        const key = el.getAttribute('data-persist')
        if (key)
          persisted.set(key, el)
      }

      document.title = nextDoc.title
      for (const incoming of nextDoc.querySelectorAll('[data-persist]')) {
        const key = incoming.getAttribute('data-persist')
        const existing = key ? persisted.get(key) : undefined
        if (existing !== undefined)
          incoming.replaceWith(existing)
      }

      document.body.replaceWith(nextDoc.body)
      if (push)
        history.pushState(null, '', res.url || url)
      window.scrollTo(0, 0)
      window.dispatchEvent(new CustomEvent('kay:navigate', { detail: { url: res.url || url } }))
    }

    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown }
    if (typeof doc.startViewTransition === 'function')
      doc.startViewTransition(applySwap)
    else
      applySwap()
  }
  finally {
    navigating = false
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return
    const target = event.target as Element | null
    const link = target?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!link || link.target || link.hasAttribute('download') || link.hasAttribute('data-no-spa'))
      return

    const url = new URL(link.href, location.href)
    if (url.origin !== location.origin)
      return
    if (url.pathname === location.pathname && url.search === location.search && url.hash)
      return

    event.preventDefault()
    void navigate(url.href, true)
  })

  window.addEventListener('popstate', () => {
    void navigate(location.href, false)
  })
}
