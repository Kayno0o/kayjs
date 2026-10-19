import type { LivePage, LiveRequest, LiveUpdate } from './live-value'
import { withBase } from './base'
import { CACHE_LIVE_ID } from './cache-live-id'
import { dirtyGuard, navigation } from './navigation'
import { decodeServerValue } from './wire'

// The twin of `readEvents` in live.ts, kept apart so the code every page loads does not carry it: keep the backoffs alike.

// The cached values a page follows (`cached(..., { live: true })`) are kept up to date by the route live values use, `POST /_kay/live`, through a reader of its own: this module stays out of the code every page loads, so it imports nothing of the runtime that code does not already reach.
// A `resource()` reading a route the same way follows the keys the route's handler read, through the proof its answer carries.

const ROUTE = '/_kay/live'
const SCRIPT = 'script[data-kay-live]'
// The longest a tab waits before it loads the page again, so every tab showing a value does not ask for the page at the same moment.
const JITTER_MS = 750
const FIRST_RETRY_MS = 1000
const LAST_RETRY_MS = 30_000
// A refused connection asks the page for a new proof once in this long: a refusal that stays is backed off, not rendered again.
const REFUSAL_MS = 60_000

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

function pagesOf(): LivePage[] {
  return [...document.querySelectorAll(SCRIPT)].map(script => decodeServerValue(script.textContent) as LivePage)
}

// Follows the cached values the page shown read, and lets go of those it no longer does: called when a page is shown, as it may carry other keys than the last. The connection stays while the keys do, moves with them and closes with the last.
export function followCaches(): void {
  const next = new Map<string, number>()

  for (const page of pagesOf()) {
    for (const [id, key, at] of page.values) {
      if (id === CACHE_LIVE_ID)
        next.set(key, at as number)
    }
  }

  rendered = next

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
  const keys = JSON.stringify([...new Set([...rendered.keys(), ...[...routes.values()].flatMap(route => [...route.reads.keys()])])].sort())

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

  const ask = () => {
    const wanted = waitingRoutes.get(owner)
    const route = routes.get(owner)

    waitingRoutes.delete(owner)

    // Not if the resource is gone, or an answer since read what changed.
    if (wanted && route && [...wanted].some(([name, time]) => time >= (route.reads.get(name) ?? Infinity)))
      route.refetch()
  }
  const shown = () => {
    if (document.hidden)
      return

    document.removeEventListener('visibilitychange', shown)
    setTimeout(ask, Math.random() * JITTER_MS)
  }

  if (document.hidden)
    document.addEventListener('visibilitychange', shown)
  else
    setTimeout(ask, Math.random() * JITTER_MS)
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
      await (await import('./navigate-api')).refresh()
    else if (!dirtyGuard())
      location.reload()
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
