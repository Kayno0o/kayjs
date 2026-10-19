import type { DevProblems } from './dev-boot'
import { withBase } from './base'
import { skew } from './build'
import { dispatch, hydrate, render } from './dom'
import { ISLAND } from './markers'
import { flush, recordSignals, reportError, root, setErrorReporter } from './reactive'
import { freshPrefix, withIds } from './uid'
import { decodeServerValue } from './wire'

export { refreshForEdit } from './dev-refresh'
export { startNavigation } from './navigate'

export type IslandRegistry = Record<string, () => Promise<{ default: (props: object) => unknown }>>

interface IslandElement extends HTMLElement {
  // Set once hydrated, so the inline hydration script stops queuing its events.
  _$k?: boolean
  // Gives a hydrated island the props of the next page, which kept it.
  _$p?: ((props: object) => void) | undefined
}

const SERVER_ISLAND = 'slot[data-kay-server]'
const started = new WeakSet<HTMLElement>()
// What disposes each hydrated island, so a page swap can end the ones it takes away: their effects, timers and connections.
const disposers = new WeakMap<Node, () => void>()
// Where the browser sends the errors it meets, for the server's `onError`.
const ERROR_URL = '/_kay/error'
const CACHE_SCRIPT = 'script[data-kay-cache]'
// Whether a page carried cached values to follow, so the page swapped in after it lets go of them.
let following = false

// Defined by `kay build --static`, whose host has no server to take the reports. Tested where it is read, not through a constant, so the bundler drops the code sending them.
declare const KAY_STATIC_EXPORT: true | undefined
const MAX_REPORTS = 10
const reported = new Set<string>()
// Set in development: renders an island noting its signals, for an edited version of it to take their values back.
let rendering: (<T>(element: HTMLElement, run: () => T, values?: unknown[]) => T) | undefined
const signalsOf = new WeakMap<HTMLElement, () => unknown[]>()
// How long each island's last hydration or render took, in development, for the inspector.
const hydrationMs = new WeakMap<HTMLElement, number>()

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

  // The dev tool lists what kay caught too, as the browser fires nothing for it.
  if (process.env.NODE_ENV !== 'production')
    (globalThis as { $kayProblems?: DevProblems }).$kayProblems?.push({ level: 'error', kind: 'uncaught', text: String(error), error, island })

  if (typeof KAY_STATIC_EXPORT === 'undefined')
    sendError(error, island)
})

if (typeof window !== 'undefined' && typeof KAY_STATIC_EXPORT === 'undefined') {
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

// Loads the code that keeps the cached values the page read with `live: true` up to date, only for a page that carries some.
async function followCaches(): Promise<void> {
  following = true

  try {
    (await import('./live-cache')).followCaches()
  }
  catch {}
}

// Hydrates every island the server rendered, loading each component's chunk on demand; resolves once the eager ones are done.
// Running it again over the same root leaves the islands it already took alone.
export async function hydrateIslands(registry: IslandRegistry, root: ParentNode = document): Promise<void> {
  const eager: Promise<void>[] = []

  if (following || document.querySelector(CACHE_SCRIPT))
    void followCaches()

  for (const element of root.querySelectorAll<HTMLElement>(SERVER_ISLAND)) {
    if (started.has(element))
      continue

    started.add(element)

    let fetched: Promise<void> | undefined
    const run = async () => fetched ??= fetchServerIsland(registry, element)

    void whenHydrating((when) => {
      when.whenVisible(element, run, true)
      when.whenIdle(run)
    }, run)
  }

  for (const element of root.querySelectorAll<HTMLElement>(ISLAND)) {
    if (started.has(element))
      continue

    started.add(element)
    const run = async () => hydrateIsland(registry, element)

    if (element.dataset.hydrate === 'visible')
      void whenHydrating(when => when.whenVisible(element, run), run)
    else if (element.dataset.hydrate === 'idle')
      void whenHydrating(when => when.whenIdle(run), run)
    else
      eager.push(run())
  }

  await Promise.all(eager)
}

// Its own chunk, which only a page with an island hydrating on `visible` or `idle`, or a deferred server island, loads. One a deploy removed asks the build, which reloads the page; one that fails with the build unchanged (offline, a dev server restarting) hydrates now, as waiting would leave the island inert.
async function whenHydrating(start: (when: typeof import('./hydrate-when')) => void, now: () => Promise<void>): Promise<void> {
  let when: typeof import('./hydrate-when')

  try {
    when = await import('./hydrate-when')
  }
  catch {
    if (!await skew())
      await now()

    return
  }

  start(when)
}

// Its own chunk, which only a page deferring a server island loads.
async function fetchServerIsland(registry: IslandRegistry, element: HTMLElement): Promise<void> {
  const { fetchServerIsland: fetchIt } = await import('./fetch-island')

  await fetchIt(element)
  await hydrateIslands(registry, element)
}

// The chunk file the server named in an island's markup sits beside this runtime, so the page's URL and the site's base do not matter.
// Only a bare file name is imported: an island's markup may come from content, and it can never name another origin or folder.
const CHUNK_FILE = /^[^/\\:?#%]+\.js$/

async function hydrateIsland(registry: IslandRegistry, element: HTMLElement): Promise<void> {
  const id = element.dataset.component ?? ''
  const file = element.dataset.chunk ?? ''
  const load = registry[id] ?? (CHUNK_FILE.test(file) ? async () => import(new URL(file, import.meta.url).href) as ReturnType<IslandRegistry[string]> : undefined)

  // What was clicked on it is dropped, as it never hydrates.
  if (!load) {
    takeEvents(element)
    console.error(`[kay] no client chunk for island ${id}`)

    return
  }

  let loaded: [Awaited<ReturnType<IslandRegistry[string]>>, Awaited<ReturnType<typeof staticSlots>>, Awaited<ReturnType<typeof livePropsOf>>]

  try {
    loaded = await Promise.all([load(), staticSlots(registry, element), livePropsOf(element)])
  }
  catch (error) {
    // A chunk that failed to load is dropped like a missing one.
    takeEvents(element)

    if (await skew())
      return

    throw error
  }

  const [{ default: component }, slots, live] = loaded

  // A page swap took it away while its chunk loaded: hydrated now, its effects would outlive it. One in a static slot its island hid hydrates as it shows it again.
  if (!element.isConnected) {
    started.delete(element)

    return
  }

  const given = element.dataset.props === undefined ? {} : decodeServerValue(element.dataset.props) as Record<string, unknown>
  const [props, update] = live ? live(given) : [given, undefined]

  for (const [key, slot] of Object.entries(slots))
    Object.defineProperty(props, key, { value: slot, enumerable: true, configurable: true })

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

  // Mounted first, its onMount run, as a click on an island already hydrated finds it.
  if (early.length > 0)
    flush()

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

// Its own chunk, which only a page holding a persistent island loads: the one kind of island the next page gives other props to.
async function livePropsOf(element: HTMLElement): Promise<typeof import('./live-props').liveProps | undefined> {
  return element.dataset.persist === undefined ? undefined : (await import('./live-props')).liveProps
}

// The static slots a static parent gave the island, whose code only a page holding such an island loads.
async function staticSlots(registry: IslandRegistry, element: HTMLElement): Promise<Record<string, () => Node[]>> {
  return element.dataset.slots === undefined ? {} : (await import('./static-slots')).islandSlots(element, root => void hydrateIslands(registry, root))
}

function noted<T>(element: HTMLElement, run: () => T): T {
  return rendering ? rendering(element, run) : run()
}

// Development: `kay dev`'s page script calls `$kayHot` with the islands an edit changed, which swap in, keeping their signals, rather than the page reloading; its inspector reads their values through `$kaySignals`, and how long each took to hydrate through `$kayHydrationMs`.
export function enableHotSwap(registry: IslandRegistry): void {
  rendering = (element, run, values) => {
    const started = performance.now()
    const recorded = recordSignals(run, values)

    hydrationMs.set(element, performance.now() - started)
    signalsOf.set(element, recorded.values)

    return recorded.result
  }
  ;(globalThis as { $kayHot?: (swap: HotSwap) => Promise<boolean> }).$kayHot = async swap => hotSwap(registry, swap)
  ;(globalThis as { $kaySignals?: (element: HTMLElement) => unknown[] | undefined }).$kaySignals = element => signalsOf.get(element)?.()
  ;(globalThis as { $kayHydrationMs?: (element: HTMLElement) => number | undefined }).$kayHydrationMs = element => hydrationMs.get(element)
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
      const props = { ...element.dataset.props === undefined ? {} : decodeServerValue(element.dataset.props) as object, ...await staticSlots(registry, element) }

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

// Ends every island under `root`, `root` itself included, as a page swap takes them away.
export function disposeIslands(root: ParentNode): void {
  for (const element of [root, ...root.querySelectorAll(ISLAND)]) {
    disposers.get(element)?.()
    disposers.delete(element)
  }
}

// The clicks, inputs and changes the inline hydration script queued on the island while it waited for its chunk.
function takeEvents(element: HTMLElement): Event[] {
  const queue = (globalThis as { _$K?: Event[] })._$K ?? []
  const taken: Event[] = []

  // Not those of an island in one of its static slots, which takes its own; those of an island a page swap took away go, as it never hydrates.
  for (const event of queue.splice(0)) {
    const target = event.target as Element

    if (target.closest?.(ISLAND) === element)
      taken.push(event)
    else if (target.isConnected)
      queue.push(event)
  }

  return taken
}
