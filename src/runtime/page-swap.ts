import type { FetchedPage, Swap } from './navigation'
import type { Policy } from './swap-flight'
import { historyState, leave, leaving, navigation, pageKey, restoreScroll, saveScroll } from './navigation'
import { NAVIGATION_ENTRY } from './navigation-entry'
import { forgetPageData } from './page-data'
import { HTML, ownOrigin, PAGE_TIMEOUT_MS, pageFor } from './swap-fetch'
import { bounded, CHUNK_TIMEOUT_MS, inFlight, LATE, policyOf } from './swap-flight'
import { moveFocus } from './swap-focus'
import { mergeHead, swapRoot } from './swap-head'
import { heldLate, holding, swapBody } from './swap-kept'
import { transitioned, viewTransitions } from './swap-transition'
import { addressChanged } from './with-query'

export { HTML, PAGE_TIMEOUT_MS, prefetch } from './swap-fetch'
export { CHUNK_TIMEOUT_MS } from './swap-flight'
export { TRANSITION_TIMEOUT_MS } from './swap-transition'

// The page swap itself, which `./navigate` loads once a visitor is about to follow a link, and `./forms` once a form is posted.
// The body's content becomes the next page's, morphed so what renders again stays the same element, islands kept only by `persist` or a refresh.
// Everything else follows one rule: what the server served changes as the next page serves it, what a script changed or added since stays the script's. The served state is `served` for `<html>`, read from the server's meta, each head element's own `_$s` for the head, and none for `<body>`, which the server writes bare.
// Its parts: the fetch in `./swap-fetch`, `<html>` and the head in `./swap-head`, the body's islands and what they keep in `./swap-kept` (a deferred server island's render in the lazy `./swap-held`), the morph in `./swap-morph`, the focus in `./swap-focus`, view transitions in `./swap-transition`, and the policy and what the swaps under way share in `./swap-flight`.

const ENTRY_SCRIPT = 'script[type="module"][src]:not([src*="/_kay/dev/"])'
const STREAMED_TEMPLATE = 'template[data-kay-await]'
// `BUILD_META` of `./swap` written out, as importing it would have the islands' entry export it to this chunk.
const BUILD_TAG = 'meta[name="kay-build"]'

export async function go(url: URL, swap: Swap): Promise<void> {
  if (swap.intent === 'refresh' && inFlight.asked) {
    const [started, loads] = [navigation.current, navigation.loads]

    try {
      await inFlight.asked
    }
    catch {}

    // The swap went to another URL, ended in a full load or a newer one took over, whose page is as recent as the refresh would give.
    if (navigation.current !== started || navigation.loads !== loads || pageKey(new URL(location.href)) !== pageKey(url))
      return
  }

  const done = swapTo(url, swap)

  if (swap.intent === 'refresh') {
    await done

    return
  }

  inFlight.asked = done

  try {
    await done
  }
  finally {
    if (inFlight.asked === done)
      inFlight.asked = undefined
  }
}

async function swapTo(url: URL, swap: Swap): Promise<void> {
  navigation.flush?.()

  if (swap.focused instanceof HTMLInputElement || swap.focused instanceof HTMLTextAreaElement)
    swap = { ...swap, held: swap.focused.value }

  if (swap.link) {
    // The nearest `data-keep-scroll` decides, `"false"` meaning a plain scroll to the top.
    const keeper = swap.link.closest('[data-keep-scroll]')

    swap = { ...swap, scroll: keeper && keeper.getAttribute('data-keep-scroll') !== 'false' ? 'keep' : undefined, transition: !swap.link.closest('[data-no-transition]') }
  }

  const token = ++navigation.current
  const controller = new AbortController()

  const key = pageKey(url)

  if (inFlight.fetch?.key !== key)
    inFlight.fetch?.controller.abort()

  inFlight.fetch = { controller, key }
  void holding()

  // Another page only: the same one with another query, or a form sending it back to itself, is not left.
  if (url.pathname !== location.pathname)
    navigation.visits = (navigation.visits ?? 0) + 1

  const isCurrent = () => token === navigation.current
  const { history: change } = policyOf(swap)

  if (change !== 'none')
    saveScroll()

  document.documentElement.setAttribute('aria-busy', 'true')

  try {
    let page: FetchedPage

    try {
      const asked = pageFor(url, controller.signal)
      // A refresh runs in the background and may be slow: only a visit is given up on.
      const fetched = swap.intent === 'refresh' ? await asked : await bounded(asked, PAGE_TIMEOUT_MS)

      // A page that never answered is loaded by the browser.
      if (fetched === LATE) {
        controller.abort()

        if (isCurrent())
          leave(url)

        return
      }

      page = fetched
    }
    catch {
      // A fetch a newer navigation cancelled leaves nothing to load.
      if (isCurrent())
        leave(url)

      return
    }

    if (!isCurrent())
      return

    try {
      await show(page, url.hash, swap, isCurrent)
    }
    catch (error) {
      // A page the swap could not put in place is loaded instead, as following the link would have.
      console.error(error)

      if (isCurrent())
        leave(new URL(page.url), pageKey(new URL(location.href)) === pageKey(new URL(page.url)) || change === 'none')
    }
  }
  finally {
    if (isCurrent())
      document.documentElement.removeAttribute('aria-busy')
  }
}

// Puts a fetched page in place of this one; anything that is no page of this build, a file or an error answered as text, is loaded or shown as the browser would.
export async function show(page: FetchedPage, hash: string, swap: Swap, isCurrent: () => boolean = () => true): Promise<void> {
  const target = new URL(page.url)
  const policy = policyOf(swap)
  // A page loaded fully in place of a swap that takes no history entry replaces the current one, as going back made one already.
  const replaces = policy.history === 'none'

  target.hash = hash

  // A page asking for full loads, or isolated otherwise, is still refreshed in place, its query changed included: the document stays the one it loaded.
  if (!HTML.test(page.type) || !ownOrigin(page.url) || (page.full && target.pathname !== location.pathname)) {
    leave(target, replaces)

    return
  }

  const next = new DOMParser().parseFromString(page.html, 'text/html')

  // Another build or another locale is a fresh start: its islands and messages are not this page's.
  if (!runsHere(next) || next.documentElement.lang !== document.documentElement.lang) {
    leave(target, replaces)

    return
  }

  // Only a page the server streamed carries the templates, so the code putting them in place loads for those alone.
  if (next.querySelector(STREAMED_TEMPLATE)) {
    let streamed: typeof import('./swap-streamed') | typeof LATE = LATE

    try {
      streamed = await bounded(import('./swap-streamed'), CHUNK_TIMEOUT_MS)
    }
    catch {}

    // A chunk a deploy replaced is gone, or its request never answers: the page loads in full, unless another navigation took over.
    if (streamed === LATE) {
      if (isCurrent())
        leave(target, replaces)

      return
    }

    if (!isCurrent())
      return

    streamed.applyStreamed(next)
  }

  const root = swapRoot(next)
  const head = mergeHead(next)
  const holds = holding()

  await head.loaded

  // A chunk that never answers is given up on as one that failed: the next page's copy of the island shows, inert until fetched.
  const kept = holds && await bounded(holds, CHUNK_TIMEOUT_MS)

  if (kept === LATE)
    heldLate()

  const held = kept === LATE ? undefined : kept

  // Another navigation started meanwhile and shows its own page; the head it merges drops what this one added.
  if (!isCurrent())
    return

  const commit = () => {
    if (!isCurrent())
      return

    if (navigation.shown === '' || new URL(navigation.shown).pathname !== target.pathname) {
      navigation.arrivals = (navigation.arrivals ?? 0) + 1

      for (const close of leaving)
        close()
    }

    document.title = next.title
    root()
    head.commit()
    inFlight.typing = process.env.NODE_ENV !== 'production' && navigation.typed === true

    try {
      swapBody(next, policy, held)
    }
    finally {
      inFlight.typing = false
      inFlight.renamed.clear()
    }

    forgetPageData()
    writeHistory(policy, target)
    addressChanged()

    if (pageKey(target) !== navigation.shown)
      navigation.page++

    navigation.shown = pageKey(target)

    if (policy.scroll !== 'keep')
      restoreScroll(swap.saved, hash)

    void moveFocus(swap, policy)

    navigation.hooks!.hydrate(document.body)
    void navigation.hooks!.arrive?.(target.search, scrollY)
    // For plain scripts, which no island tells of the swap.
    document.dispatchEvent(new CustomEvent('kay:navigate', { detail: { url: target.href } }))
  }

  if (policy.transition && viewTransitions())
    await transitioned(commit)
  else
    commit()
}

// The entry a swap adds or replaces, holding where the page it leaves was scrolled to.
function writeHistory({ history: change }: Policy, target: URL): void {
  if (change === 'push') {
    navigation.at++
    history.pushState(historyState(), '', target)
  }
  else if (change === 'replace') {
    history.replaceState(historyState(), '', target)
  }
}

// A page loading no entry keeps the one running, as does one loading this page's own or the navigation-only entry of this build, whose code the islands' entry holds too. A page running the navigation-only entry thus loads one holding islands in full.
function runsHere(next: Document): boolean {
  const script = entryOf(next)
  const entry = script?.getAttribute('src')

  if (entry == null || entry === entryOf(document)?.getAttribute('src'))
    return true

  const build = buildOf(next)

  return script!.hasAttribute(NAVIGATION_ENTRY) && build !== undefined && build === buildOf(document)
}

// The dev tool's scripts lead a page with no islands under `kay dev`, and are no build's entry.
function entryOf(page: Document): HTMLScriptElement | null {
  return page.querySelector<HTMLScriptElement>(ENTRY_SCRIPT)
}

function buildOf(page: Document): string | undefined {
  return page.querySelector<HTMLMetaElement>(BUILD_TAG)?.content
}
