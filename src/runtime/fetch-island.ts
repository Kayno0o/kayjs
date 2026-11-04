import { ApiError } from './api-error-class'
import { requestIsland } from './island-request'

export interface FetchedIsland extends HTMLElement {
  // The inert copy the island replaced, which a page swap compares the next page's copy with.
  _$b?: string
  // The control of a held island that had the focus when the page swap took it away, as inert content keeps none.
  _$f?: HTMLElement
}

// How many times a request is made and how long to wait before each retry, a wait cut short when the tab is shown or the network is back.
const RETRY_WAITS_MS = [1000, 3000]

// A refusal that asking again cannot change.
const settled = (error: ApiError) => error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429

// Resolves at the next sign that the tab is shown or the network is back, or when `signal` aborts.
async function wake(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      document.removeEventListener('visibilitychange', done)
      removeEventListener('online', done)
      signal.removeEventListener('abort', done)
      resolve()
    }

    document.addEventListener('visibilitychange', done)
    addEventListener('online', done)
    signal.addEventListener('abort', done)
  })
}

// Waits `ms`, then for the tab to be visible and the network to be up; ends at once when `signal` aborts.
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)

    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })

  while (!signal.aborted && (document.hidden || navigator.onLine === false))
    await wake(signal)
}

// What the island's `@failed` block holds, rendered hidden beside the inert copy; a control inside it marked `data-kay-retry` asks again.
const FAILURE = ':scope > [data-kay-failure]'
const RETRY = '[data-kay-retry]'
const retries = new WeakMap<HTMLElement, () => void>()

// Shows the block and wires its retry controls once per island, by delegation as the block comes back with the inert copy a page swap restores.
function showFailure(element: HTMLElement, retry: () => void): void {
  const block = element.querySelector<HTMLElement>(FAILURE)

  if (block === null)
    return

  // The block cannot be clicked inside an inert island: the copy beside it is inert on its own.
  element.removeAttribute('inert')
  block.hidden = false

  if (retries.has(element))
    return

  retries.set(element, retry)
  element.addEventListener('click', (event) => {
    if (element.hasAttribute('data-kay-failed') && event.target instanceof Element && element.contains(event.target.closest(RETRY))) {
      event.preventDefault()
      retries.get(element)?.()
    }
  })
}

function announce(element: HTMLElement, type: string, detail: object): void {
  element.dispatchEvent(new CustomEvent(type, { bubbles: true, detail: { element, id: element.dataset.kayServer, ...detail } }))
}

// A deferred server island rendered for this visitor in place of the inert copy standing in for it, asked again after a failure and a wait; resolves false when it failed for good or was aborted, true once the content is in.
// A failure for good leaves the inert copy (one a page swap held, shown inert with its last render while asked again, gets its inert copy back), marks the island `data-kay-failed` and dispatches `kay:server-island-error` with an `ApiError` and a `retry()`; success dispatches `kay:server-island`. `aria-busy` is set while it loads.
// `dispose` ends the islands of the copy it replaces, which may have hydrated; an island taken out of the document (a page swap) aborts the request.
export async function fetchServerIsland(element: FetchedIsland, dispose: (root: ParentNode) => void, retry: () => void): Promise<boolean> {
  const controller = new AbortController()
  const { signal } = controller
  // The page swap takes the island out of the document, which ends its request; watched here, so a page with no deferred island pays nothing.
  const watch = new MutationObserver(() => element.isConnected || controller.abort())
  const held = element._$b
  // Taken before any exit, so a fetch that fails or meets a skew leaves no node referenced.
  const focused = focusIn(element)

  watch.observe(document, { childList: true, subtree: true })
  element.setAttribute('aria-busy', 'true')
  element.removeAttribute('data-kay-failed')
  element.querySelector<HTMLElement>(FAILURE)?.setAttribute('hidden', '')

  try {
    let text: string | undefined

    try {
      for (let attempt = 0; ; attempt++) {
        try {
          text = await requestIsland(element, signal)

          break
        }
        catch (error) {
          const wait = RETRY_WAITS_MS[attempt]

          if (signal.aborted || wait === undefined || !(error instanceof ApiError) || settled(error))
            throw error

          await pause(wait, signal)

          if (signal.aborted)
            throw error
        }
      }
    }
    catch (error) {
      if (!signal.aborted) {
        if (held !== undefined)
          element.innerHTML = held

        element.setAttribute('data-kay-failed', '')
        showFailure(element, retry)
        // Written out rather than through kayLog, whose import would hoist log.ts into every page's eager chunk.
        console.warn(`[kay] the server island ${element.dataset.kayServer} of ${location.pathname} was not loaded`, error)
        announce(element, 'kay:server-island-error', { error, retry })
      }

      return false
    }

    if (text === undefined || signal.aborted)
      return false

    // A fault of the swap itself is no network failure: the held copy comes back and the error goes on to the page's error reporting.
    try {
      element._$b ??= element.innerHTML
      dispose(element)
      element.innerHTML = text
      element.removeAttribute('inert')
      focused?.()
    }
    catch (error) {
      if (held !== undefined)
        element.innerHTML = held

      throw error
    }

    announce(element, 'kay:server-island', {})

    return true
  }
  finally {
    watch.disconnect()
    element.removeAttribute('aria-busy')
  }
}

// The focus a page swap took from the island, which replacing its content cannot give back: the returned function gives it to the equivalent control of the new content, by id, else by name, else by place among the controls of its tag.
function focusIn(island: FetchedIsland): (() => void) | undefined {
  const held = island._$f

  delete island._$f

  if (!held?.isConnected || !island.contains(held))
    return undefined

  const { id, tagName } = held
  const name = held.getAttribute('name') ?? ''
  const place = [...island.querySelectorAll(tagName)].indexOf(held)

  return () => {
    // A visitor who focused something else meanwhile keeps it.
    if (document.activeElement !== null && document.activeElement !== document.body)
      return

    const same = [...island.querySelectorAll<HTMLElement>(tagName)]
    const again = (id === '' ? undefined : island.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)) ?? (name === '' ? undefined : same.find(element => element.getAttribute('name') === name)) ?? same[place]

    again?.focus({ preventScroll: true })
  }
}
