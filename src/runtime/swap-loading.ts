import { pageKey } from './navigation'
import { LOADING_HEADER, NAVIGATE_HEADER, RELOAD_HEADER } from './swap'
import { ENTRY_SCRIPT, inFlight, policyOf } from './swap-flight'
import { swapBody } from './swap-kept'

// Puts the loading page of `url`, which the server renders from the nearest `_loading.kay` inside the layouts of the page, in place of the one left, while the page itself is still on its way.
// The head, history, scroll, focus and `kay:navigate` are the page's to change once it arrives, so this only morphs the body, as a refresh does; a page already there, or a navigation that moved on, leaves it be.
export async function showLoading(url: URL, signal: AbortSignal, waiting: () => boolean): Promise<void> {
  // Neither read from nor written to the browser's cache, which could hand the page this answer.
  const response = await fetch(pageKey(url), { headers: { accept: 'text/html', [NAVIGATE_HEADER]: '1', [LOADING_HEADER]: '1' }, cache: 'no-store', redirect: 'manual', signal })

  // A route with no loading page answers 204, a guard's refusal or a redirect something else: none is shown.
  // A page loaded in full has no use for one shown first.
  if (response.status !== 200 || !response.headers.has(LOADING_HEADER) || response.headers.has(RELOAD_HEADER))
    return

  const html = await response.text()

  if (!waiting())
    return

  const next = new DOMParser().parseFromString(html, 'text/html')

  // Another locale or build is a fresh start, which the page itself loads in full, and streamed blocks are the page swap's to place.
  if (next.documentElement.lang !== document.documentElement.lang || entryOf(next) !== entryOf(document) || next.querySelector('template[data-kay-await]') !== null)
    return

  // An island the page left keeps living only if the next body holds its placeholder, which the loading page does not, so it would be lost for the page that follows.
  for (const live of document.body.querySelectorAll<HTMLElement>('[data-persist]')) {
    if (next.body.querySelector(`[data-persist="${CSS.escape(live.dataset.persist!)}"]`) === null)
      return
  }

  try {
    swapBody(next, policyOf({ intent: 'refresh' }), undefined, undefined)
  }
  finally {
    inFlight.renamed.clear()
  }
}

function entryOf(page: Document): string | null | undefined {
  return page.querySelector(ENTRY_SCRIPT)?.getAttribute('src')
}
