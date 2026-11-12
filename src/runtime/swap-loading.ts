import { pageKey } from './navigation'
import { LOADING_HEADER, NAVIGATE_HEADER } from './swap'
import { inFlight, policyOf } from './swap-flight'
import { swapBody } from './swap-kept'

// Puts the loading page of `url`, which the server renders from the nearest `_loading.kay` inside the layouts of the page, in place of the one left, while the page itself is still on its way.
// The head, history, scroll, focus and `kay:navigate` are the page's to change once it arrives, so this only morphs the body, as a refresh does; a page already there, or a navigation that moved on, leaves it be.
export async function showLoading(url: URL, signal: AbortSignal, waiting: () => boolean): Promise<void> {
  // Neither read from nor written to the browser's cache, which could hand the page this answer.
  const response = await fetch(pageKey(url), { headers: { accept: 'text/html', [NAVIGATE_HEADER]: '1', [LOADING_HEADER]: '1' }, cache: 'no-store', redirect: 'manual', signal })

  // A route with no loading page answers 204, a guard's refusal or a redirect something else: none is shown.
  if (response.status !== 200 || !response.headers.has(LOADING_HEADER))
    return

  const html = await response.text()

  if (!waiting())
    return

  const next = new DOMParser().parseFromString(html, 'text/html')

  // Another locale is a fresh start, which the page itself loads in full.
  if (next.documentElement.lang !== document.documentElement.lang)
    return

  try {
    swapBody(next, policyOf({ intent: 'refresh' }), undefined, undefined)
  }
  finally {
    inFlight.renamed.clear()
  }
}
