import type { LivePage, LiveRequest, LiveUpdate } from './live-value'
import { withBase } from './base'
import { CACHE_LIVE_ID } from './cache-live-id'
import { dirtyGuard, navigation } from './navigation'
import { decodeServerValue } from './wire'

// The twin of `readEvents` in live.ts, kept apart so the code every page loads does not carry it: keep the backoffs alike.

// The cached values a page follows (`cached(..., { live: true })`) are kept up to date by the route live values use, `POST /_kay/live`, through a reader of its own: this module stays out of the code every page loads, so it imports nothing of the runtime that code does not already reach.

const ROUTE = '/_kay/live'
const SCRIPT = 'script[data-kay-live]'
// The longest a tab waits before it loads the page again, so every tab showing a value does not ask for the page at the same moment.
const JITTER_MS = 750
const FIRST_RETRY_MS = 1000
const LAST_RETRY_MS = 30_000
// A refused connection asks the page for a new proof once in this long: a refusal that stays is backed off, not rendered again.
const REFUSAL_MS = 60_000

// The time the page shown read each key it follows.
let rendered = new Map<string, number>()
// The connection open, and the keys it asked for.
let connection: { controller: AbortController, keys: string } | undefined
let attempt = 0
let refused = 0
let retry: ReturnType<typeof setTimeout> | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let running = false
// What was invalidated while the page loaded, by key, to be held against the page that arrives.
const meanwhile = new Map<string, number>()
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
  }

  const keys = JSON.stringify([...next.keys()].toSorted())

  if (connection?.keys === keys)
    return

  stop()

  if (next.size > 0)
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
    proofs: pagesOf().map(page => ({ keys: page.values.map(([id, key]) => [id, key] as [string, string]), at: page.at, sig: page.sig })),
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
  const read = rendered.get(key)

  if (read === undefined || at < read)
    return

  if (running) {
    meanwhile.set(key, at)

    return
  }

  schedule()
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
    if (navigation.refresh)
      await navigation.refresh()
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
