import type { Elysia } from 'elysia'
import type { LiveConfig } from '../config'
import type { LivePage, LiveRequest, LiveUpdate } from '../runtime/live-value'
import type { ServerScope } from '../runtime/reactive'
import { AsyncLocalStorage } from 'node:async_hooks'
import { broadcast, onClockHeard, onKeysInvalidated, onLiveRead } from '../runtime/cache'
import { CACHE_LIVE_ID } from '../runtime/cache-live-id'
import { checkLiveWrites, live, LIVE_ROUTE, liveSlot, PROOF_LIFETIME_MS, slotValue, watchSlot } from '../runtime/live-value'
import { PRESENCE_LIVE_ID } from '../runtime/presence'
import { currentServerScope } from '../runtime/reactive'
import { encodeValue, unsendable } from '../runtime/wire'
import { isCrossSite } from './actions'
import { liveLimits } from './config-limits'
import { readCapped } from './errors'
import { eventStream, StreamRefused } from './event-stream'
import { presenceEntry } from './presence'
import { clientAddress, overLimit } from './protection'
import { signedText, signText } from './stamp'

// What a proof is signed for, apart from every other thing kay signs.
const PROOF = 'live'

// What a page carrying live values holds, which a prerendered file cannot: the values and their proof are per request.
export const LIVE_MARK = '<script type="application/json" data-kay-live'
// Added to the script of a page that follows cached values, which the entry script looks for.
const CACHE_MARK = ' data-kay-cache'
const MAX_REQUEST_BYTES = 64 * 1024
// The keys one connection watches, and the length of a key.
const MAX_WATCHED = 500
const MAX_KEY_LENGTH = 256
// A tab's id: letters, digits and hyphens, so it never reads as part of a presence member beside it in the store.
const TAB_ID = /^[\w-]{1,64}$/
const MINUTE_MS = 60_000
const LIMIT = 'kay:live'

// A page's proof and watch list both carry its keys, so this many of the longest fit the request.
const MAX_CACHE_KEYS = 100
// A route's proof travels in a header, which a proxy with its default buffer refuses past about 4 KB: each key counts as its encoded length and what the proof adds around it, and all of them are at most this.
const MAX_ROUTE_KEY_BYTES = 4000
const ROUTE_KEY_OVERHEAD = 50

// The header a GET route answers with when its handler read keys with `live: true`.
export const LIVE_HEADER = 'x-kay-live'
// How many keys read with `live: true` are remembered for their last invalidation.
const MAX_STAMPED = 10_000
// How many watched keys the eviction passes over before it gives up for now, so a set of watched keys does not make each read scan it whole.
const MAX_SKIPS = 32
// A clock a little ahead of the server's still dates a proof the server made.
const SKEW_MS = 5000
// How far ahead of its clock a process tells the others it has dated reads, and the most it believes another's clock to be ahead of its own: the skew a proof tolerates and a beat.
const BEAT_MS = 250
const MAX_AHEAD_MS = SKEW_MS + BEAT_MS

interface CacheReads {
  // The time the render read each key it follows.
  at: Map<string, number>
  sent: Set<string>
  // Whether a route's handler reads them, whose proof is a header; the key text read so far.
  route: boolean
  bytes: number
}

const cacheReads = new AsyncLocalStorage<CacheReads>()
// The reads of each API request in flight, for the hook that answers it.
const routeReads = new WeakMap<Request, CacheReads>()
// Least recently read or watched first.
const stamped = new Set<string>()
// The last invalidation time of each key a page followed, which a connection sends first: the declaration gives 0 to a key never invalidated.
const stamps = (live as (initial: (key: string) => number, id: string, name: string) => { set: (key: string, value: number) => void, delete: (key: string) => void })((): number => 0, CACHE_LIVE_ID, 'cache')

// Runs the render of a request, loads included, so the cached values it reads with `live: true` are the page's to follow.
export function inLiveReads<T>(run: () => T): T {
  return cacheReads.run({ at: new Map(), sent: new Set(), route: false, bytes: 0 }, run)
}

// Runs a GET route's handler so the live keys it reads are the proof its answer carries, for a `resource()` to follow.
export function inRouteReads<T>(request: Request, run: () => T): T {
  const reads: CacheReads = { at: new Map(), sent: new Set(), route: true, bytes: 0 }

  routeReads.set(request, reads)

  return cacheReads.run(reads, run)
}

// The proof of what a route's handler read, as a header value, or undefined when it read no key with `live: true`.
export function routeProof(request: Request): string | undefined {
  const reads = routeReads.get(request)

  routeReads.delete(request)

  if (reads === undefined || reads.at.size === 0)
    return undefined

  return encodeURIComponent(encodeValue(cachePage([...reads.at])))
}

onLiveRead((key) => {
  const reads = cacheReads.getStore()

  if (reads === undefined || reads.at.has(key))
    return

  if (key.length > MAX_KEY_LENGTH || reads.at.size >= MAX_CACHE_KEYS)
    throw new RangeError(`kay: cached('${key.slice(0, 40)}...') with live: true: a key is at most ${MAX_KEY_LENGTH} characters and a page follows at most ${MAX_CACHE_KEYS} keys`)

  const size = reads.route ? encodeURIComponent(key).length + ROUTE_KEY_OVERHEAD : 0

  if (reads.route && reads.bytes + size > MAX_ROUTE_KEY_BYTES)
    throw new RangeError(`kay: cached('${key.slice(0, 40)}...') with live: true: a route follows keys up to about ${MAX_ROUTE_KEY_BYTES} bytes together, as its proof travels in a header`)

  reads.bytes += size
  reads.at.set(key, stampNow())

  remember(key)
  announce(Date.now())
})

// The latest clock reading this process told the other processes of, and the latest it heard of from them.
let announced = 0
let heardAhead = 0
// The latest time an invalidation was stamped with.
let lastStamp = 0

// The time a read or an invalidation is dated with: never before the clock of a process this one heard of, nor the last invalidation, so a read is dated after every invalidation stamped before it and an invalidation not before any read dated before it. A burst of invalidations moves it a millisecond each, until the clock catches up.
function stampNow(): number {
  return Math.max(Date.now(), heardAhead, lastStamp + 1)
}

// Tells the processes sharing a store that this one dates reads up to a quarter of a second ahead of its clock, at most four times a second: a process whose clock is behind then stamps an invalidation after the read, not before it.
function announce(now: number): void {
  if (now < announced)
    return

  announced = now + BEAT_MS
  broadcast({ pages: [], at: announced })
}

onClockHeard((at) => {
  heardAhead = Math.max(heardAhead, Math.min(at, Date.now() + MAX_AHEAD_MS))
})

// Keeps a key's invalidation time from now on, whichever process rendered the page: the least recent ones go past the bound, but never one a connection watches.
function remember(key: string): void {
  stamped.delete(key)
  stamped.add(key)

  const slot = liveSlot(CACHE_LIVE_ID)
  let skips = 0

  for (const old of stamped) {
    if (stamped.size <= MAX_STAMPED || skips >= MAX_SKIPS)
      break

    // Watched, so as good as read now: moved behind the rest, where the next passes meet the keys nobody watches first.
    if ((slot?.listeners.get(old)?.size ?? 0) > 0) {
      skips++
      stamped.delete(old)
      stamped.add(old)

      continue
    }

    stamped.delete(old)
    stamps.delete(old)
  }
}

// Whether the render in progress read a key with `live: true`, which its page follows.
export function followsCaches(): boolean {
  return (cacheReads.getStore()?.at.size ?? 0) > 0
}

// An invalidation, this process's or another's, tells the pages following what it dropped: each key gets the time, which only grows and is never before a read another process dated with a clock ahead of this one.
onKeysInvalidated((matches) => {
  const slot = liveSlot(CACHE_LIVE_ID)

  if (slot === undefined)
    return []

  const at = stampNow()

  for (const key of stamped) {
    if (matches(key)) {
      lastStamp = at
      stamps.set(key, at)
    }
  }

  return []
})

const open = new Map<string, number>()

// The proof that a page read these keys of these values: whoever holds it is let watch exactly them, as whoever rendered the page was.
function proofText(keys: [string, string][], at: number): string {
  return `${at}\n${keys.map(key => JSON.stringify(key)).toSorted().join('\n')}`
}

function proofOf(keys: [string, string][], at: number): string {
  return signText(PROOF, proofText(keys, at))
}

// Whether the proof is signed, made by this server and not older than its lifetime.
function proves(proof: LiveRequest['proofs'][number], now: number): boolean {
  return proof.at <= now + SKEW_MS && now - proof.at <= PROOF_LIFETIME_MS && signedText(PROOF, proofText(proof.keys, proof.at), proof.sig)
}

// A value a browser cannot be sent is refused where it is written, not where a connection would later fail on it.
function checkSendable(label: string, value: unknown): void {
  try {
    encodeValue(value)
  }
  catch (error) {
    const reason = unsendable(error)

    throw new TypeError(`kay: the live value ${label} was set to something that cannot reach the browser${reason === undefined ? '' : `: ${reason}`}`, { cause: error })
  }
}

// The script a page carries for the live values its render read since the last one, and the cached values it follows: their ids with the proof of them, and each value as it rendered, for the islands to hydrate with.
export function liveScript(scope: ServerScope | undefined = currentServerScope()): string {
  const fresh = [...scope?.live?.values() ?? []].filter(read => !read.sent)
  const cache = cacheReads.getStore()
  const following = cache === undefined ? [] : [...cache.at].filter(([key]) => !cache.sent.has(key))

  if (fresh.length === 0 && following.length === 0)
    return ''

  for (const read of fresh)
    read.sent = true

  for (const [key] of following)
    cache!.sent.add(key)

  const page = cachePage(following, fresh)

  return `${LIVE_MARK}${following.length > 0 ? CACHE_MARK : ''}>${encodeValue(page).replaceAll('<', '\\u003c')}</script>`
}

// The values a page or a route answer holds, with the proof of them.
function cachePage(following: [string, number][], fresh: { id: string, key: string, value: unknown }[] = []): LivePage {
  const at = Date.now()
  const values: LivePage['values'] = [...fresh.map(read => [read.id, read.key, read.value] as LivePage['values'][number]), ...following.map(([key, read]) => [CACHE_LIVE_ID, key, read] as LivePage['values'][number])]

  return { at, sig: proofOf(values.map(([id, key]) => [id, key]), at), values }
}

interface Watched {
  id: string
  key: string
  value: () => unknown
  watch: (listener: () => void) => () => void
}

// The updates a connection sends: every watched value as it is now, then the ones that changed, as often as they do.
// It ends when the proofs it was let in on expire, `lifetime` from now.
// It holds a connection slot of the client from the moment it is read until it ends, and is refused when the client has none by then, which a browser retries after its backoff: a response nobody reads holds nothing.
function updates(watched: Watched[], lifetime: number, client: string, most: number): AsyncIterable<LiveUpdate[]> {
  return {
    [Symbol.asyncIterator]() {
      if ((open.get(client) ?? 0) >= most)
        return { next: async () => Promise.reject(new StreamRefused('kay: the client holds too many live connections')) }

      open.set(client, (open.get(client) ?? 0) + 1)

      const dirty = new Map<string, Watched>()
      let wake: (() => void) | undefined
      const state = { ended: false }
      let first = true
      const stops = watched.map(entry => entry.watch(() => {
        dirty.set(`${entry.id}\0${entry.key}`, entry)
        wake?.()
      }))
      let expiry: ReturnType<typeof setTimeout> | undefined
      const end = () => {
        if (state.ended)
          return

        state.ended = true
        clearTimeout(expiry)

        for (const stop of stops)
          stop()

        release(client)
        wake?.()
      }

      expiry = setTimeout(end, lifetime)
      expiry.unref()

      return {
        async next() {
          if (first) {
            first = false

            return { value: watched.map(entry => [entry.id, entry.key, entry.value()] as LiveUpdate), done: false }
          }

          while (!state.ended && dirty.size === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve
            })
          }

          wake = undefined

          if (state.ended)
            return { value: undefined, done: true }

          const batch = [...dirty.values()].map(entry => [entry.id, entry.key, entry.value()] as LiveUpdate)

          dirty.clear()

          return { value: batch, done: false }
        },
        async return() {
          end()

          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}

function release(client: string): void {
  const left = (open.get(client) ?? 1) - 1

  if (left <= 0)
    open.delete(client)
  else
    open.set(client, left)
}

// What a request asks for, or undefined when it is no request of this route.
function readRequest(text: string): LiveRequest | undefined {
  try {
    const { proofs, watch, tab } = JSON.parse(text) as Partial<LiveRequest>

    if (!Array.isArray(proofs) || !Array.isArray(watch) || watch.length > MAX_WATCHED)
      return undefined

    if (!proofs.every(proof => Array.isArray(proof.keys) && proof.keys.every(key => Array.isArray(key) && typeof key[0] === 'string' && typeof key[1] === 'string') && typeof proof.sig === 'string' && typeof proof.at === 'number'))
      return undefined

    if (!watch.every(entry => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1].length <= MAX_KEY_LENGTH))
      return undefined

    return tab !== undefined && (typeof tab !== 'string' || !TAB_ID.test(tab)) ? undefined : { proofs, watch, tab }
  }
  catch {
    return undefined
  }
}

// `POST /_kay/live`: one event stream per page carrying the live values its islands read. A value is sent only to a request holding the proof a page that read it carried, so a guard on the page covers it.
export function serveLive(app: Elysia, config?: LiveConfig): void {
  const { connections, perMinute } = liveLimits(config)

  checkLiveWrites(checkSendable)
  app.post(LIVE_ROUTE, async ({ request, server }) => {
    if (isCrossSite(request))
      return new Response(null, { status: 403 })

    if (Number(request.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES)
      return new Response(null, { status: 413 })

    if (overLimit(LIMIT, clientAddress(request, server), perMinute, MINUTE_MS) !== undefined)
      return new Response(null, { status: 429 })

    const text = await readCapped(request, MAX_REQUEST_BYTES)

    if (text === undefined)
      return new Response(null, { status: 413 })

    const asked = readRequest(text)

    if (asked === undefined || asked.watch.length === 0)
      return new Response(null, { status: 400 })

    const now = Date.now()
    const valid = asked.proofs.filter(proof => proves(proof, now))
    // The newest proof naming each key: the one that lets a page watch it for the longest.
    const proven = new Map<string, number>()

    for (const proof of valid) {
      for (const key of proof.keys) {
        const at = JSON.stringify(key)

        proven.set(at, Math.max(proven.get(at) ?? 0, proof.at))
      }
    }

    const watched: Watched[] = []
    let oldest = Infinity
    let stale = false
    // What names the tab in the rooms it joins: its own, or one for this connection alone.
    const tab = asked.tab ?? crypto.randomUUID()

    for (const [id, key] of asked.watch) {
      const slot = liveSlot(id)
      const provenAt = proven.get(JSON.stringify([id, key]))
      const here = id === PRESENCE_LIVE_ID && provenAt !== undefined ? presenceEntry(key, tab) : undefined

      if (here !== undefined) {
        oldest = Math.min(oldest, provenAt!)
        watched.push({ id, key, ...here })
      }
      // A room and member no page proves, or one whose proof is out of date: refused, so a tab does not join as a member its page never named.
      else if (id === PRESENCE_LIVE_ID) {
        stale = true
      }
      else if (slot !== undefined && provenAt !== undefined && (slot.keyed || key === '')) {
        oldest = Math.min(oldest, provenAt)

        // A process that did not render the page, or restarted since, still hears the invalidations of what its proof covers.
        if (id === CACHE_LIVE_ID)
          remember(key)

        watched.push({ id, key, value: () => slotValue(slot, key), watch: listener => watchSlot(slot, key, listener) })
      }
      // A followed cache key whose proof is out of date: refused, so the tab takes new proofs rather than follow part of what it shows.
      else if (id === CACHE_LIVE_ID) {
        stale = true
      }
    }

    // Nothing proven to watch: refused, as a request with a forged proof is.
    if (watched.length === 0 || stale)
      return new Response(null, { status: 403 })

    const client = clientAddress(request, server)

    if ((open.get(client) ?? 0) >= connections)
      return new Response(null, { status: 429 })

    return eventStream(updates(watched, PROOF_LIFETIME_MS - (now - oldest), client, connections))
  }, { parse: 'none' })
}
