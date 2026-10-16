import type { Elysia } from 'elysia'
import type { LivePage, LiveRequest, LiveUpdate } from '../runtime/live-value'
import type { ServerScope } from '../runtime/reactive'
import { checkLiveWrites, LIVE_ROUTE, liveSlot, PROOF_LIFETIME_MS, slotValue, watchSlot } from '../runtime/live-value'
import { currentServerScope } from '../runtime/reactive'
import { encodeValue, unsendable } from '../runtime/wire'
import { isCrossSite } from './actions'
import { eventStream } from './api'
import { readCapped } from './errors'
import { clientAddress, overLimit } from './protection'
import { signedText, signText } from './stamp'

// What a proof is signed for, apart from every other thing kay signs.
const PROOF = 'live'

// What a page carrying live values holds, which a prerendered file cannot: the values and their proof are per request.
export const LIVE_MARK = '<script type="application/json" data-kay-live>'
const MAX_REQUEST_BYTES = 64 * 1024
// The keys one connection watches, and the length of a key.
const MAX_WATCHED = 500
const MAX_KEY_LENGTH = 256
const CONNECTIONS_PER_MINUTE = 120
const MINUTE_MS = 60_000
const LIMIT = 'kay:live'

// How many connections one client holds at once: a few tabs, not a flood.
export const MAX_CONNECTIONS = 20
// A clock a little ahead of the server's still dates a proof the server made.
const SKEW_MS = 5000
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
function checkSendable(id: string, value: unknown): void {
  try {
    encodeValue(value)
  }
  catch (error) {
    const reason = unsendable(error)

    throw new TypeError(`kay: the live value ${id} was set to something that cannot reach the browser${reason === undefined ? '' : `: ${reason}`}`, { cause: error })
  }
}

// The script a page carries for the live values its render read since the last one: their ids with the proof of them, and each value as it rendered, for the islands to hydrate with.
export function liveScript(scope: ServerScope | undefined = currentServerScope()): string {
  const reads = scope?.live

  if (reads === undefined)
    return ''

  const fresh = [...reads.values()].filter(read => !read.sent)

  if (fresh.length === 0)
    return ''

  for (const read of fresh)
    read.sent = true

  const at = Date.now()
  const page: LivePage = { at, sig: proofOf(fresh.map(read => [read.id, read.key]), at), values: fresh.map(read => [read.id, read.key, read.value]) }

  return `${LIVE_MARK}${encodeValue(page).replaceAll('<', '\\u003c')}</script>`
}

interface Watched {
  id: string
  key: string
  value: () => unknown
  watch: (listener: () => void) => () => void
}

// The updates a connection sends: every watched value as it is now, then the ones that changed, as often as they do.
// It ends when the proofs it was let in on expire, `lifetime` from now, and `closed` runs once it has ended.
function updates(watched: Watched[], lifetime: number, closed: () => void): AsyncIterable<LiveUpdate[]> {
  return {
    [Symbol.asyncIterator]() {
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

        closed()
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

// What a request asks for, or undefined when it is no request of this route.
function readRequest(text: string): LiveRequest | undefined {
  try {
    const { proofs, watch } = JSON.parse(text) as Partial<LiveRequest>

    if (!Array.isArray(proofs) || !Array.isArray(watch) || watch.length > MAX_WATCHED)
      return undefined

    if (!proofs.every(proof => Array.isArray(proof.keys) && proof.keys.every(key => Array.isArray(key) && typeof key[0] === 'string' && typeof key[1] === 'string') && typeof proof.sig === 'string' && typeof proof.at === 'number'))
      return undefined

    if (!watch.every(entry => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[1].length <= MAX_KEY_LENGTH))
      return undefined

    return { proofs, watch }
  }
  catch {
    return undefined
  }
}

// `POST /_kay/live`: one event stream per page carrying the live values its islands read. A value is sent only to a request holding the proof a page that read it carried, so a guard on the page covers it.
export function serveLive(app: Elysia): void {
  checkLiveWrites(checkSendable)
  app.post(LIVE_ROUTE, async ({ request, server }) => {
    if (isCrossSite(request))
      return new Response(null, { status: 403 })

    if (Number(request.headers.get('content-length') ?? 0) > MAX_REQUEST_BYTES)
      return new Response(null, { status: 413 })

    if (overLimit(LIMIT, clientAddress(request, server), CONNECTIONS_PER_MINUTE, MINUTE_MS) !== undefined)
      return new Response(null, { status: 429 })

    const text = await readCapped(request, MAX_REQUEST_BYTES)

    if (text === undefined)
      return new Response(null, { status: 413 })

    const asked = readRequest(text)

    if (asked === undefined || asked.watch.length === 0)
      return new Response(null, { status: 400 })

    const now = Date.now()
    const valid = asked.proofs.filter(proof => proves(proof, now))
    const proven = new Set(valid.flatMap(proof => proof.keys.map(key => JSON.stringify(key))))
    const watched: Watched[] = []

    for (const [id, key] of asked.watch) {
      const slot = liveSlot(id)

      if (slot !== undefined && proven.has(JSON.stringify([id, key])) && (slot.keyed || key === ''))
        watched.push({ id, key, value: () => slotValue(slot, key), watch: listener => watchSlot(slot, key, listener) })
    }

    // Nothing proven to watch: refused, as a request with a forged proof is.
    if (watched.length === 0)
      return new Response(null, { status: 403 })

    const client = clientAddress(request, server)

    if ((open.get(client) ?? 0) >= MAX_CONNECTIONS)
      return new Response(null, { status: 429 })

    open.set(client, (open.get(client) ?? 0) + 1)

    const lifetime = PROOF_LIFETIME_MS - (now - Math.min(...valid.map(proof => proof.at)))

    return eventStream(updates(watched, lifetime, () => {
      const left = (open.get(client) ?? 1) - 1

      if (left <= 0)
        open.delete(client)
      else
        open.set(client, left)
    }))
  }, { parse: 'none' })
}
