import type { ApiError } from './api-error'
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

function announce(element: HTMLElement, type: string, detail: object): void {
  element.dispatchEvent(new CustomEvent(type, { bubbles: true, detail: { element, id: element.dataset.kayServer, ...detail } }))
}

// A deferred server island rendered for this visitor in place of the inert copy standing in for it, asked again after a failure and a wait; resolves false when it failed for good or was aborted, true once the content is in.
// A failure leaves the inert copy (or, for one a page swap held, the last render), marks the island `data-kay-failed` and dispatches `kay:server-island-error` with an `ApiError` and a `retry()`; success dispatches `kay:server-island`. `aria-busy` is set while it loads.
// `dispose` ends the islands of the copy it replaces, which may have hydrated; a page swap disposing it (`kay:island-gone`) aborts the request.
export async function fetchServerIsland(element: FetchedIsland, dispose: (root: ParentNode) => void, retry: () => void): Promise<boolean> {
  const controller = new AbortController()
  const { signal } = controller
  const gone = () => controller.abort()
  const held = element._$b
  // Taken before any exit, so a fetch that fails or meets a skew leaves no node referenced.
  const focused = focusIn(element)

  element.addEventListener('kay:island-gone', gone)
  element.setAttribute('aria-busy', 'true')
  element.removeAttribute('data-kay-failed')

  try {
    let text: string | undefined

    for (let attempt = 0; ; attempt++) {
      try {
        text = await requestIsland(element, signal)

        break
      }
      catch (error) {
        const wait = RETRY_WAITS_MS[attempt]

        if (signal.aborted || wait === undefined || (error as ApiError).status === undefined || settled(error as ApiError))
          throw error

        await pause(wait, signal)
      }
    }

    if (text === undefined || signal.aborted)
      return false

    element._$b ??= element.innerHTML
    dispose(element)
    element.innerHTML = text
    element.removeAttribute('inert')
    focused?.()
    announce(element, 'kay:server-island', {})

    return true
  }
  catch (error) {
    if (held !== undefined)
      element.innerHTML = held

    if (!signal.aborted) {
      element.setAttribute('data-kay-failed', '')
      announce(element, 'kay:server-island-error', { error, retry })
    }

    return false
  }
  finally {
    element.removeAttribute('aria-busy')
    element.removeEventListener('kay:island-gone', gone)
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
