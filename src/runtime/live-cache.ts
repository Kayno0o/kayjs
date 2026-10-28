import type { LivePage, LiveRequest, LiveUpdate } from './live-value'
import { withBase } from './base'
import { CACHE_LIVE_ID } from './cache-live-id'
import { dirtyGuard, navigation } from './navigation'
import { decodeServerValue } from './wire'

// The cached values a page follows (`cached(..., { live: true })`) are kept up to date by the route live values use, `POST /_kay/live`, through a reader of its own: this module stays out of the code every page loads, so it imports nothing of the runtime that code does not already reach.
// A `resource()` reading a route the same way follows the keys the route's handler read, through the proof its answer carries.
// The twin of `readEvents` in live.ts and `parseEvents` in sse.ts, which every page loads: its backoff starts at a second rather than half of one, and waits for the tab to show but not for the network to come back.

const ROUTE = '/_kay/live'
// A deferred island's script is told from the page's by its attribute, so a page's renewal of its proofs leaves it alone.
const SCRIPT = 'script[data-kay-live],script[data-kay-island]'
const SERVER_ISLAND = 'slot[data-kay-server]'
// The longest a tab waits before it loads the page again, so every tab showing a value does not ask for the page at the same moment.
const JITTER_MS = 750
const FIRST_RETRY_MS = 1000
const LAST_RETRY_MS = 30_000
// A refused connection asks the page for a new proof once in this long: a refusal that stays is backed off, not rendered again.
const REFUSAL_MS = 60_000
// Fired by live-value.client.ts when it asks for new proofs.
const RENEW_EVENT = 'kay-renew'

// The longest a refresh waits for a swap in progress: one that never clears `aria-busy` (failed or aborted) would otherwise park every later invalidation.
export const IDLE_MS = 20_000

// What a `resource()` follows: the proof its last answer carried, the time the handler read each key, and the call that asks the route again.
interface Route {
  page: LivePage
  reads: Map<string, number>
  refetch: () => unknown
}

// The time the page shown read each key it follows.
let rendered = new Map<string, number>()
// The deferred server islands that read each followed key, with the time their render read it: the script an island's fetch carries sits inside its slot, and an invalidation fetches that island alone.
let islands = new Map<string, Map<HTMLElement, number>>()
// The deferred islands whose script holds live values: the connection their module opens takes the proof from the island, which cannot ask for a new one, so they are fetched again when the page renews its proofs.
let holding = new Set<HTMLElement>()
// The resources following a route, by their owner.
const routes = new Map<object, Route>()
// The invalidations a resource waits to answer, by key: it asks its route once the tab is shown, after a short random wait.
const waitingRoutes = new Map<object, Map<string, number>>()
// The connection open, and the keys it asked for.
let connection: { controller: AbortController, keys: string } | undefined
let attempt = 0
let refused = 0
let retry: ReturnType<typeof setTimeout> | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let running = false
// What was invalidated while the page loaded, by key, to be held against the page that arrives.
const meanwhile = new Map<string, number>()
// What was invalidated since the page was last loaded, by key, which a refresh held back by a swap in progress checks against the page then shown.
const due = new Map<string, number>()
let waiting = false
// The islands waiting for their fetch, and those fetching, with what was invalidated meanwhile, which the island then shown is asked about.
const waitingIslands = new Set<HTMLElement>()
const fetchingIslands = new Map<HTMLElement, Map<string, number>>()

// An app swapping no pages would reload the page for it, which a renewal is not worth.
addEventListener(RENEW_EVENT, () => {
  for (const slot of navigation.hooks === undefined ? [] : holding)
    askIsland(slot)
})

function pagesOf(): LivePage[] {
  return [...document.querySelectorAll(SCRIPT)].map(script => decodeServerValue(script.textContent) as LivePage)
}

// Follows the cached values the page shown read, and lets go of those it no longer does: called when a page is shown, as it may carry other keys than the last. The connection stays while the keys do, moves with them and closes with the last.
export function followCaches(): void {
  const next = new Map<string, number>()
  const inIslands = new Map<string, Map<HTMLElement, number>>()
  const holders = new Set<HTMLElement>()

  for (const script of document.querySelectorAll(SCRIPT)) {
    const slot = script.closest<HTMLElement>(SERVER_ISLAND)
    const page = decodeServerValue(script.textContent) as LivePage

    if (slot !== null && page.values.some(([id]) => id !== CACHE_LIVE_ID))
      holders.add(slot)

    for (const [id, key, at] of page.values) {
      if (id !== CACHE_LIVE_ID)
        continue

      if (slot === null)
        next.set(key, at as number)
      else
        (inIslands.get(key) ?? inIslands.set(key, new Map()).get(key)!).set(slot, at as number)
    }
  }

  rendered = next
  islands = inIslands
  holding = holders

  if (next.size === 0) {
    clearTimeout(timer)
    timer = undefined
    meanwhile.clear()
    due.clear()
  }

  follow()
}

// Follows the keys a route's answer carried the proof of for a resource, or lets go of them when `header` is null: called after each answer, which replaces the last, and when the resource is gone.
export function followRoute(owner: object, header: string | null, refetch: () => unknown): void {
  if (header === null) {
    routes.delete(owner)
    waitingRoutes.delete(owner)
  }
  else {
    const page = decodeServerValue(decodeURIComponent(header)) as LivePage

    routes.set(owner, { page, reads: new Map(page.values.map(([, key, at]) => [key, at as number])), refetch })
  }

  follow()
}

// Moves the connection to the keys followed now, and closes it with the last.
function follow(): void {
  const keys = JSON.stringify([...new Set([...rendered.keys(), ...islands.keys(), ...[...routes.values()].flatMap(route => [...route.reads.keys()])])].sort())

  if (connection?.keys === keys)
    return

  stop()

  if (keys !== '[]')
    void connect(keys)
}

function stop(): void {
  connection?.controller.abort()
  connection = undefined
  attempt = 0
  clearTimeout(retry)
  retry = undefined
}

async function connect(keys: string): Promise<void> {
  const controller = new AbortController()
  const request: LiveRequest = {
    proofs: [...new Map([...pagesOf(), ...[...routes.values()].map(route => route.page)].map(page => [page.sig, page])).values()].map(page => ({ keys: page.values.map(([id, key]) => [id, key] as [string, string]), at: page.at, sig: page.sig })),
    watch: (JSON.parse(keys) as string[]).map(key => [CACHE_LIVE_ID, key]),
  }

  connection = { controller, keys }

  try {
    const response = await fetch(withBase(ROUTE), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: controller.signal })

    // The proof is no longer taken, an hour old or from before a restart: the page shown again carries a new one.
    if (response.status === 403 && Date.now() - refused > REFUSAL_MS) {
      refused = Date.now()
      void response.body?.cancel()
      stop()

      // The resources ask their routes again for new proofs, and the page for its own.
      for (const route of routes.values())
        route.refetch()

      for (const slot of new Set([...islands.values()].flatMap(readers => [...readers.keys()])))
        askIsland(slot)

      if (rendered.size > 0)
        await load()

      return
    }

    if (response.ok && response.body)
      await read(response.body, controller)
  }
  catch {}

  if (!controller.signal.aborted)
    reconnect(controller, keys)
}

async function read(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  controller.signal.addEventListener('abort', () => void reader.cancel(), { once: true })

  for (;;) {
    const { done, value } = await reader.read()

    if (done)
      return

    buffer += decoder.decode(value, { stream: true })

    for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
      const data = buffer.slice(0, end).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')

      buffer = buffer.slice(end + 2)

      if (data !== '') {
        attempt = 0
        refused = 0

        for (const [id, key, at] of decodeServerValue(data) as LiveUpdate[]) {
          if (id === CACHE_LIVE_ID)
            changed(key, at as number)
        }
      }
    }
  }
}

// Opens the connection again after a growing delay, shortened by up to half at random so the tabs a restart dropped together come back apart, and not while the tab is hidden.
function reconnect(controller: AbortController, keys: string): void {
  const delay = Math.min(FIRST_RETRY_MS * 2 ** attempt++, LAST_RETRY_MS) * (0.5 + Math.random() / 2)
  const open = () => {
    if (connection?.controller === controller)
      void connect(keys)
  }

  retry = setTimeout(() => {
    if (!document.hidden) {
      open()

      return
    }

    const shown = () => {
      if (document.hidden)
        return

      document.removeEventListener('visibilitychange', shown)
      open()
    }

    document.addEventListener('visibilitychange', shown)
  }, delay)
}

// A key was invalidated at `at` by the server's clock, the same clock that dated the page's read of it: at or after the read, the page shows what is gone.
function changed(key: string, at: number): void {
  for (const [owner, route] of routes) {
    const read = route.reads.get(key)

    if (read !== undefined && at >= read)
      askRoute(owner, key, at)
  }

  for (const [slot, read] of islands.get(key) ?? []) {
    if (at < read)
      continue

    const during = fetchingIslands.get(slot)

    if (during === undefined)
      askIsland(slot)
    else
      during.set(key, at)
  }

  const read = rendered.get(key)

  if (read === undefined || at < read)
    return

  if (running) {
    meanwhile.set(key, at)

    return
  }

  due.set(key, at)
  schedule()
}

// A resource asks its route again, once the tab is shown and after a short random wait, for all the invalidations that came meanwhile.
function askRoute(owner: object, key: string, at: number): void {
  const pending = waitingRoutes.get(owner)

  if (pending) {
    pending.set(key, at)

    return
  }

  waitingRoutes.set(owner, new Map([[key, at]]))

  soon(() => {
    const wanted = waitingRoutes.get(owner)
    const route = routes.get(owner)

    waitingRoutes.delete(owner)

    // Not if the resource is gone, or an answer since read what changed.
    if (wanted && route && [...wanted].some(([name, time]) => time >= (route.reads.get(name) ?? Infinity)))
      route.refetch()
  })
}

// Runs after a short random wait, once the tab is shown.
function soon(run: () => void): void {
  const shown = () => {
    if (document.hidden)
      return

    document.removeEventListener('visibilitychange', shown)
    setTimeout(run, Math.random() * JITTER_MS)
  }

  if (document.hidden)
    document.addEventListener('visibilitychange', shown)
  else
    setTimeout(run, Math.random() * JITTER_MS)
}

// A deferred server island fetches itself again, alone: one asked already absorbs the events meanwhile.
function askIsland(slot: HTMLElement): void {
  if (waitingIslands.has(slot))
    return

  waitingIslands.add(slot)
  soon(() => {
    waitingIslands.delete(slot)
    void refetchIsland(slot)
  })
}

// The island is replaced by what the server renders for this visitor now, the one it had ended first. An app swapping no pages has nothing to hydrate it again, so the page reloads, unless a change is waiting to be typed over.
async function refetchIsland(slot: HTMLElement): Promise<void> {
  const hooks = navigation.hooks

  // The fetch in progress renders with proofs made after the ask.
  if (!slot.isConnected || fetchingIslands.has(slot))
    return

  if (hooks === undefined) {
    reloaded()

    return
  }

  const during = new Map<string, number>()

  fetchingIslands.set(slot, during)

  try {
    // A swap in progress is the visitor's click, which takes the island away or brings the page as it is now.
    if (document.documentElement.hasAttribute('aria-busy'))
      await idle()

    if (!slot.isConnected)
      return

    const { refetchServerIsland } = await import('./refetch-island')
    const focus = await refetchServerIsland(slot, () => hooks.dispose(slot))

    await hooks.hydrate(slot)
    // The read times of the island now shown, which the changes that came meanwhile are held against.
    followCaches()
    focus()
  }
  // A fetch that failed leaves the island as it was, shown until the next change, and the connection a refused proof closed opens again.
  catch {
    during.clear()
    follow()
  }
  finally {
    fetchingIslands.delete(slot)
  }

  // What was invalidated while it was fetched is asked again only if the island now shown read the key before.
  for (const [key, at] of during)
    changed(key, at)
}

// A tab nobody looks at loads the page once it is shown again.
function schedule(): void {
  if (timer !== undefined)
    return

  if (document.hidden) {
    if (!waiting) {
      waiting = true
      document.addEventListener('visibilitychange', onShown)
    }

    return
  }

  timer = setTimeout(() => void load(), Math.random() * JITTER_MS)
}

function onShown(): void {
  if (document.hidden)
    return

  waiting = false
  document.removeEventListener('visibilitychange', onShown)
  schedule()
}

// A refresh that cannot run, as when a deploy removed the chunk holding it, leaves the page stale: it is loaded whole unless a change is waiting to be typed over.
async function refreshed(): Promise<void> {
  try {
    await (await import('./navigate-api')).refresh()
  }
  catch {
    reloaded()
  }
}

function reloaded(): void {
  if (!dirtyGuard())
    location.reload()
}

// Shows the page with what its loads give now, which followCaches then finds the new proofs of; an app swapping no pages reloads it, unless a change is waiting to be typed over.
async function load(): Promise<void> {
  timer = undefined
  running = true

  try {
    // A swap in progress is the visitor's click: refreshing now would supersede it, and the page it arrives on is as recent as that fetch.
    if (document.documentElement.hasAttribute('aria-busy')) {
      await idle()

      if (![...due].some(([key, at]) => at >= (rendered.get(key) ?? Infinity))) {
        due.clear()

        return
      }
    }

    due.clear()

    if (navigation.hooks)
      await refreshed()
    else
      reloaded()
  }
  finally {
    running = false
  }

  // What was invalidated while the page loaded is asked for again if the page now shown read the key before.
  const late = [...meanwhile]

  meanwhile.clear()

  for (const [key, at] of late)
    changed(key, at)
}

// Resolves once no page swap is in progress, or after `IDLE_MS` when one never ends.
async function idle(): Promise<void> {
  const root = document.documentElement

  await new Promise<void>((resolve) => {
    let giveUp: ReturnType<typeof setTimeout> | undefined
    const observer = new MutationObserver(() => {
      if (!root.hasAttribute('aria-busy'))
        finish()
    })

    function finish(): void {
      observer.disconnect()
      clearTimeout(giveUp)
      resolve()
    }

    giveUp = setTimeout(finish, IDLE_MS)
    observer.observe(root, { attributes: true, attributeFilter: ['aria-busy'] })
  })
}
