import type { Handle, LiveKey, LivePage, LiveRequest, LiveUpdate } from './live-value.shared'
import { withBase } from './base'
import { readEvents } from './live'
import { initialOf, keyText, LIVE_ROUTE, LIVE_SCRIPT, PROOF_LIFETIME_MS } from './live-value.shared'
import { pageData } from './page-data'
import { isHydrating, onCleanup, ownSignal, tracking, untrack, whenHydrated } from './reactive'
import { decodeServerValue } from './wire'

// The browser's half of `live()`: the values the islands read, the one connection that follows them and the renewal of the proofs it opens with.

// Defined by the browser build: tested where it is read, so the bundler drops the test for a server.
declare const KAY_BROWSER: true | undefined

const RENEW_RETRY_MS = 60_000
// How long a page that no longer holds live values waits before asking again after a refusal: the proof it has will not be taken again.
const GONE_RETRY_MS = 5 * 60_000
// Fired on the window when the page asks for new proofs, for the deferred islands that hold live values to fetch themselves again.
const RENEW_EVENT = 'kay-renew'
// How long a browser waits after the values it reads change before it opens, moves or closes its connection, so the islands of a page and a swap share one.
const SETTLE_MS = 30

interface Entry {
  read: () => unknown
  write: (value: unknown) => void
  // The value the page rendered it with, which an island claiming its markup reads whatever arrived since.
  rendered: { value: unknown } | undefined
  // What the page held for it when the connection last delivered a value, compared with the page read later: a page rendered before that delivery holds nothing the connection has not moved past. Wrapped, as a page holding nothing for it differs from no delivery.
  delivered: { rendered: { value: unknown } | undefined } | undefined
  // Read while an island claims its markup, so the value that arrived since shows once it is hydrated.
  hydrated: () => number
  bump: () => void
  bumping: boolean
  watchers: number
}

interface BrowserSlot {
  id: string
  initial: unknown
  keyed: boolean
  entries: Map<string, Entry>
}

const browserSlots = new Map<string, BrowserSlot>()

// The keys the open connection carries, and the ones the islands read now.
export const wanted = new Map<string, number>()
// Set by `presence()`: whether the keys read now hold a connection open in a hidden tab, and what names the tab to the server.
export const hold: { open?: () => boolean, tab?: string } = {}
let current: { keys: Set<string>, reader: ReturnType<typeof readEvents<LiveUpdate[]>> } | undefined
let settling: ReturnType<typeof setTimeout> | undefined
let renewing: ReturnType<typeof setTimeout> | undefined

function pagesOf(): LivePage[] {
  return typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined' ? [] : pageData<LivePage>(LIVE_SCRIPT, decodeServerValue)
}

function renderedValue(id: string, key: string): { value: unknown } | undefined {
  for (const page of pagesOf()) {
    const found = page.values.find(entry => entry[0] === id && entry[1] === key)

    if (found)
      return { value: found[2] }
  }

  return undefined
}

function entryOf(slot: BrowserSlot, key: string): Entry {
  let entry = slot.entries.get(key)

  if (!entry) {
    const rendered = renderedValue(slot.id, key)
    const [read, write] = ownSignal<unknown>(rendered ? rendered.value : initialOf(slot, key))
    const [hydrated, bump] = ownSignal(0)

    entry = { read, write, rendered, delivered: undefined, hydrated, bump: () => {
      entry!.bumping = false
      bump(untrack(hydrated) + 1)
    }, bumping: false, watchers: 0 }
    slot.entries.set(key, entry)
  }

  return entry
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b))
    return true

  try {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  catch {
    return false
  }
}

function watch(slot: BrowserSlot, key: string, entry: Entry): void {
  const at = JSON.stringify([slot.id, key])

  if (entry.watchers === 0) {
    // A page rendered since holds a fresher value than the last the connection delivered, or none when the viewer is not the one it was rendered for; the same render as before, or one fetched before the delivery, holds the one the connection has since moved past.
    const rendered = renderedValue(slot.id, key)
    const known = entry.delivered ? entry.delivered.rendered : entry.rendered

    entry.rendered = rendered
    entry.delivered = undefined

    if (!sameValue(known?.value, rendered?.value))
      whenHydrated(() => entry.write(rendered ? rendered.value : initialOf(slot, key)))
  }

  entry.watchers++
  wanted.set(at, (wanted.get(at) ?? 0) + 1)
  settle()

  onCleanup(() => {
    entry.watchers--

    const left = (wanted.get(at) ?? 1) - 1

    if (left <= 0)
      wanted.delete(at)
    else
      wanted.set(at, left)

    settle()
  })
}

// Ends the pause in progress, as the keys the islands read changed.
let wake: (() => void) | undefined
// Counts the syncs, for a renewal to tell that one ran while it asked.
let syncs = 0

// Resolves after `ms`, or as soon as `signal` aborts or the keys change.
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)

    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }

    signal.addEventListener('abort', done)
    wake = done
  })
}

function settle(): void {
  clearTimeout(settling)
  settling = setTimeout(sync, SETTLE_MS)
}

// Asks for the page again and takes its live scripts in place of the page's own, so a proof the server no longer takes, or is about to stop taking, is replaced by one it made now; `gone` when the page no longer holds any, as one the visitor may not see, `failed` when it could not be asked.
async function renewProofs(signal: AbortSignal | null = null): Promise<'renewed' | 'gone' | 'failed'> {
  // The deferred islands holding live values fetch themselves again, as their proofs are theirs.
  dispatchEvent(new Event(RENEW_EVENT))

  try {
    const response = await fetch(location.href, { headers: { accept: 'text/html' }, cache: 'no-store', signal })

    if (!response.ok)
      return 'failed'

    const fresh = [...new DOMParser().parseFromString(await response.text(), 'text/html').querySelectorAll(LIVE_SCRIPT)]

    if (fresh.length === 0)
      return 'gone'

    // The scripts inside a deferred island are the island's own, which its fetch renews.
    for (const old of document.querySelectorAll(`${LIVE_SCRIPT}:not(slot[data-kay-server] *)`))
      old.remove()

    document.head.append(...fresh)

    return 'renewed'
  }
  catch {
    return 'failed'
  }
}

// Gets the connection new proofs before the server stops taking the ones it opened with, counted on the browser's own clock as the server's may differ; a renewal that could not ask is tried again after a minute.
function renewLater(delay = PROOF_LIFETIME_MS / 2): void {
  clearTimeout(renewing)

  const renew = async () => {
    renewing = undefined

    if (!current)
      return

    const renewed = await renewProofs()

    if (renewed === 'failed') {
      renewLater(RENEW_RETRY_MS)

      return
    }

    if (renewed === 'renewed') {
      release()
      sync()
    }
  }

  renewing = setTimeout(() => void renew(), delay)
}

// Closes the connection and stops renewing its proof.
function release(): void {
  clearTimeout(renewing)
  renewing = undefined
  current?.reader.close()
  current = undefined
}

// Opens, moves or closes the one connection so it carries exactly the keys the islands read.
function sync(): void {
  settling = undefined
  syncs++
  wake?.()

  const keys = new Set(wanted.keys())

  // Nothing is proven without a page script, as when an island's copy hydrates before the island is fetched: the connection opens once its script is in.
  if (keys.size === 0 || pagesOf().length === 0) {
    release()

    return
  }

  followVisibility()

  if (document.hidden && !hold.open?.())
    return

  if (current && current.keys.size === keys.size && [...keys].every(key => current!.keys.has(key)))
    return

  current?.reader.close()

  const watched = [...keys].map(key => JSON.parse(key) as [string, string])
  // The proofs are read at each attempt, as a renewed page holds new ones.
  const post = async (signal: AbortSignal) => fetch(withBase(LIVE_ROUTE), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proofs: pagesOf().map(page => ({ keys: page.values.map(([id, key]) => [id, key] as [string, string]), at: page.at, sig: page.sig })), watch: watched, tab: hold.tab } satisfies LiveRequest), signal })
  const reader = readEvents<LiveUpdate[]>(async (signal) => {
    const response = await post(signal)

    if (response.status !== 403)
      return response

    // Refused: the proof may be one a restart or its age made stale, so the page is asked for a new one before the backoff.
    const before = syncs
    const renewed = await renewProofs(signal)

    if (renewed === 'renewed')
      return post(signal)

    // The page no longer holds any, as for a visitor who may not see it: the stale proof is tried again at a distance.
    if (renewed === 'gone' && syncs === before)
      await pause(GONE_RETRY_MS, signal)

    return response
  }, true, false, true)

  reader.on(apply)
  current = { keys, reader }

  if (renewing === undefined)
    renewLater()

  reader.start()
}

let followingVisibility = false

// A hidden tab holds no connection and renews no proof, unless it follows a presence key; shown again, it opens one that starts with every value as it is then. Installed by the first sync, so a bundle that never reads a live value keeps none of this module.
function followVisibility(): void {
  if (followingVisibility)
    return

  followingVisibility = true
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !hold.open?.())
      release()
    else
      sync()
  })
}

function apply(updates: LiveUpdate[]): void {
  for (const [id, key, value] of updates) {
    const entry = browserSlots.get(id)?.entries.get(key)

    if (entry) {
      entry.delivered = { rendered: renderedValue(id, key) }
      entry.write(value)
    }
  }
}

export function browserLive(id: string, initial: unknown): Handle {
  const keyed = typeof initial === 'function'
  const known = browserSlots.get(id)
  const slot: BrowserSlot = known ?? { id, initial, keyed, entries: new Map() }

  if (known) {
    known.initial = initial
    known.keyed = keyed
  }

  browserSlots.set(id, slot)

  const read = (key: string): unknown => {
    const entry = entryOf(slot, key)

    if (tracking())
      watch(slot, key, entry)

    if (isHydrating() && entry.rendered) {
      entry.hydrated()

      if (!entry.bumping) {
        entry.bumping = true
        whenHydrated(entry.bump)
      }

      return entry.rendered.value
    }

    return entry.read()
  }

  const refuse = (): never => {
    throw new TypeError(`kay: the live value ${id} is changed on the server, not in a browser`)
  }

  return Object.assign(keyed ? (key: LiveKey) => read(keyText(key)) : () => read(''), { set: refuse, ...keyed && { delete: refuse } }) as unknown as Handle
}
