import { withBase } from './base'
import { dispatch, hydrate, render } from './dom'
import { batch, createSignal, recordSignals, reportError, root, setErrorReporter } from './reactive'
import { freshPrefix, withIds } from './uid'
import { decodeValue } from './wire'

export { startNavigation } from './navigate'

export type IslandRegistry = Record<string, () => Promise<{ default: (props: object) => unknown }>>

interface IslandElement extends HTMLElement {
  // Set once hydrated, so the inline hydration script stops queuing its events.
  _$k?: boolean
  // Gives a hydrated island the props of the next page, which kept it.
  _$p?: (props: object) => void
}

// Starts loading a `visible` island this far before it scrolls into view.
const VISIBLE_MARGIN = '200px'
// Fetches a deferred server island about a screen before it scrolls into view, so a visitor never meets the copy standing in for it.
const NEAR_MARGIN = '100% 0px'
const SERVER_ISLAND = 'slot[data-kay-server]'
const IDLE_FALLBACK_MS = 200
const started = new WeakSet<HTMLElement>()
// What disposes each hydrated island, so a page swap can end the ones it takes away: their effects, timers and connections.
const disposers = new WeakMap<HTMLElement, () => void>()
const ISLAND = 'slot[data-component]'
// Where the browser sends the errors it meets, for the server's `onError`.
const ERROR_URL = '/_kay/error'
const MAX_REPORTS = 10
const reported = new Set<string>()
// Set in development: renders an island noting its signals, for an edited version of it to take their values back.
let rendering: (<T>(element: HTMLElement, run: () => T, values?: unknown[]) => T) | undefined
const signalsOf = new WeakMap<HTMLElement, () => unknown[]>()

// What a page on the code the last `kay dev` server started with swaps in rather than reloading: the chunks of each island an edit changed, by island, its own first.
export interface HotSwap {
  from: number
  islands: Record<string, string[]>
  // Chunks the page never loaded that may come along, holding nothing but edited islands.
  fresh: string[]
  // The new entry, which the page then counts as its own, so a page swapped in later is not taken for another build.
  entry?: string | undefined
}

setErrorReporter((error, island) => {
  console.error(error)
  sendError(error, island)
})

if (typeof window !== 'undefined') {
  // An error with no error object is another origin's script, whose details the browser hides: nothing to report.
  window.addEventListener('error', (event) => {
    if (event.error !== undefined && event.error !== null)
      sendError(event.error)
  })
  window.addEventListener('unhandledrejection', event => sendError(event.reason))
}

// Sends an error to the server once per message and place, a few per page load at most, with the page's path only: its query and hash may hold what the user typed.
function sendError(error: unknown, island?: string): void {
  const { name, message, stack } = error instanceof Error ? error : { name: 'Error', message: String(error), stack: undefined }
  const key = `${message}\n${stack}`

  if (reported.has(key) || reported.size >= MAX_REPORTS)
    return

  reported.add(key)
  void post(JSON.stringify({ name, message, stack, island, url: location.origin + location.pathname }))
}

async function post(body: string): Promise<void> {
  try {
    await fetch(withBase(ERROR_URL), { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body })
  }
  catch {}
}

// Hydrates every island the server rendered, loading each component's chunk on demand; resolves once the eager ones are done.
// Running it again over the same root leaves the islands it already took alone.
export async function hydrateIslands(registry: IslandRegistry, root: ParentNode = document): Promise<void> {
  const eager: Promise<void>[] = []

  for (const element of root.querySelectorAll<HTMLElement>(SERVER_ISLAND)) {
    if (started.has(element))
      continue

    started.add(element)

    let fetched: Promise<void> | undefined
    const run = async () => fetched ??= fetchServerIsland(registry, element)

    whenVisible(element, run, NEAR_MARGIN)
    whenIdle(run)
  }

  for (const element of root.querySelectorAll<HTMLElement>(ISLAND)) {
    if (started.has(element))
      continue

    started.add(element)
    const run = async () => hydrateIsland(registry, element)

    if (element.dataset.hydrate === 'visible')
      whenVisible(element, run)
    else if (element.dataset.hydrate === 'idle')
      whenIdle(run)
    else
      eager.push(run())
  }

  await Promise.all(eager)
}

// Its own chunk, which only a page deferring a server island loads.
async function fetchServerIsland(registry: IslandRegistry, element: HTMLElement): Promise<void> {
  const { fetchServerIsland: fetchIt } = await import('./fetch-island')

  await fetchIt(element)
  await hydrateIslands(registry, element)
}

async function hydrateIsland(registry: IslandRegistry, element: HTMLElement): Promise<void> {
  const id = element.dataset.component ?? ''
  const load = registry[id]

  if (!load) {
    console.error(`[kay] no client chunk for island ${id}`)

    return
  }

  const { default: component } = await load()

  // A page swap took it away while its chunk loaded: hydrated now, its effects would outlive it.
  if (!element.isConnected)
    return

  const [props, update] = liveProps(element.dataset.props === undefined ? {} : decodeValue(element.dataset.props) as Record<string, unknown>)
  const early = takeEvents(element)
  // Counted again from where the server's were, so the ids it rendered are claimed as they are.
  const ids = element.dataset.uid ?? freshPrefix()

  // A client-only island has no server markup to claim.
  if (element.dataset.client !== undefined) {
    try {
      disposers.set(element, noted(element, () => render(() => withIds(ids, () => component(props)), element)))
    }
    catch (error) {
      reportError(error, id)
    }
  }
  else {
    root((dispose) => {
      disposers.set(element, dispose)

      try {
        noted(element, () => hydrate(() => withIds(ids, () => component(props)), element))
      }
      catch (error) {
        // Markup the island would not build, such as one a browser extension changed, can fail anywhere along the way: rendered afresh rather than left dead.
        console.error(`[kay] island ${id} did not match its server markup, rendering it again: ${error instanceof Error ? error.message : String(error)}`)
        dispose()

        const markup = [...element.childNodes]

        element.textContent = ''

        try {
          disposers.set(element, noted(element, () => render(() => withIds(ids, () => component(props)), element)))
        }
        catch (failure) {
          // An error of the component itself, thrown again: the server's markup stays, lifeless, rather than nothing.
          element.replaceChildren(...markup)
          reportError(failure, id)
        }
      }
    })
  }

  (element as IslandElement)._$k = true;
  (element as IslandElement)._$p = update

  // A click or an input reaches the handlers alone, its default action done already; a change, heard on the element itself, fires again. A target an afresh render replaced is gone with its event.
  for (const event of early) {
    const target = event.target as Node

    if (!target.isConnected)
      continue

    try {
      if (event.type === 'change')
        target.dispatchEvent(new Event('change', { bubbles: true }))
      else
        dispatch(event)
    }
    catch (error) {
      console.error(error)
    }
  }
}

function noted<T>(element: HTMLElement, run: () => T): T {
  return rendering ? rendering(element, run) : run()
}

// Development: `kay dev`'s page script calls `$kayHot` with the islands an edit changed, which swap in, keeping their signals, rather than the page reloading.
export function enableHotSwap(registry: IslandRegistry): void {
  rendering = (element, run, values) => {
    const recorded = recordSignals(run, values)

    signalsOf.set(element, recorded.values)

    return recorded.result
  }
  ;(globalThis as { $kayHot?: (swap: HotSwap) => Promise<boolean> }).$kayHot = async swap => hotSwap(registry, swap)
}

// Resolves false when the page must reload instead: a new chunk holding code the page already runs, as a changed shared module, would run beside its old copy.
async function hotSwap(registry: IslandRegistry, swap: HotSwap): Promise<boolean> {
  const loaded = new Set([...document.querySelectorAll<HTMLLinkElement>('link[rel=modulepreload]')].map(link => new URL(link.href).pathname))
  const fresh = new Set(swap.fresh.map(withBase))

  for (const entry of performance.getEntriesByType('resource'))
    loaded.add(new URL(entry.name).pathname)

  const fits = (chunks: string[]) => chunks.slice(1).map(withBase).every(chunk => loaded.has(chunk) || fresh.has(chunk))
  const shown: [id: string, chunk: string][] = []

  for (const [id, chunks] of Object.entries(swap.islands)) {
    const chunk = withBase(chunks[0]!)

    if (!document.querySelector(`${ISLAND}[data-component="${CSS.escape(id)}"]`)) {
      // Not on this page: a later one rendering it loads the new chunk, unless that would bring code the page runs again.
      if (fits(chunks))
        registry[id] = async () => import(chunk) as ReturnType<IslandRegistry[string]>

      continue
    }

    if (!fits(chunks))
      return false

    shown.push([id, chunk])
  }

  const modules = await Promise.all(shown.map(async ([id, chunk]) => [id, chunk, await import(chunk) as Awaited<ReturnType<IslandRegistry[string]>>] as const))

  for (const [id, chunk, module] of modules) {
    registry[id] = async () => import(chunk) as ReturnType<IslandRegistry[string]>

    for (const element of document.querySelectorAll<HTMLElement>(`${ISLAND}[data-component="${CSS.escape(id)}"]`)) {
      const dispose = disposers.get(element)

      if (!dispose) {
        // Started without an end to call: still loading, or its last version threw. Only a reload brings it back.
        if (started.has(element))
          return false

        // Not hydrated yet: it loads the new chunk when it does.
        continue
      }

      const values = signalsOf.get(element)?.()
      const props = element.dataset.props === undefined ? {} : decodeValue(element.dataset.props) as object

      dispose()
      element.textContent = ''

      try {
        disposers.set(element, rendering!(element, () => render(() => withIds(element.dataset.uid ?? freshPrefix(), () => module.default(props)), element), values))
      }
      catch (error) {
        reportError(error, id)

        return false
      }
    }
  }

  if (swap.entry !== undefined && swap.entry !== '')
    document.querySelector('script[type="module"][src]')?.setAttribute('src', withBase(swap.entry))

  return true
}

// Props read through a signal each, so an island marked `persist` the next page gives other props shows them, as a component inside an island does.
function liveProps(initial: Record<string, unknown>): [props: object, update: (next: object) => void] {
  const props = {}
  const writes = new Map<string, (value: unknown) => void>()
  const define = (key: string, value: unknown) => {
    const [read, write] = createSignal(value, { equals: sameData }, false)

    writes.set(key, write)
    Object.defineProperty(props, key, { get: read, enumerable: true, configurable: true })
  }

  for (const [key, value] of Object.entries(initial))
    define(key, value)

  return [props, next => batch(() => {
    for (const key of new Set([...writes.keys(), ...Object.keys(next)])) {
      const value = (next as Record<string, unknown>)[key]
      const write = writes.get(key)

      if (write)
        write(value)
      else
        define(key, value)
    }
  })]
}

// Whether two decoded props hold the same data, so a prop the next page gives unchanged keeps its value, and what reads it, a `linked` edit included, is left alone.
function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b))
    return true

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b))
    return false

  if (a instanceof Date)
    return a.getTime() === (b as Date).getTime()

  if (a instanceof RegExp || a instanceof URL)
    return String(a) === String(b)

  const entries = (value: object) => value instanceof Map || value instanceof Set ? [...value.entries()] : Object.entries(value)
  const [left, right] = [entries(a), entries(b)]

  return left.length === right.length && left.every(([key, value], index) => sameData(key, right[index]![0]) && sameData(value, right[index]![1]))
}

// Ends every island under `root`, as a page swap takes them away.
export function disposeIslands(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>(ISLAND)) {
    disposers.get(element)?.()
    disposers.delete(element)
  }
}

// The clicks, inputs and changes the inline hydration script queued on the island while it waited for its chunk.
function takeEvents(element: HTMLElement): Event[] {
  const queue = (globalThis as { _$K?: Event[] })._$K ?? []
  const taken = queue.filter(event => element.contains(event.target as Node))

  for (const event of taken)
    queue.splice(queue.indexOf(event), 1)

  return taken
}

function whenVisible(element: HTMLElement, run: () => Promise<void>, margin = VISIBLE_MARGIN) {
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

function whenIdle(run: () => Promise<void>) {
  if (typeof requestIdleCallback === 'function')
    requestIdleCallback(() => void run())
  else
    setTimeout(() => void run(), IDLE_FALLBACK_MS)
}
