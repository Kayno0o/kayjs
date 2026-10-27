import type { Reply } from './types'

const KEPT_MS = 30 * 60_000
const MOST_KEPT = 200
// How many resumes and stops of one kept reply give their attempt of the action's rateLimit back; the rest stay counted, so one kept reply cannot replay the action's code for free.
const MOST_REFUNDS = 3

interface Entry {
  reply: Reply
  at: number
  // Who asked and from which action, which a resume or a stop must match.
  owner: Promise<string | undefined>
  // The reply ended, so it is the first to go when the store is full.
  ended: boolean
  // The refunds given for this reply so far.
  refunds: number
}

interface Slot {
  replies: Map<string, Entry>
  // Keys a stop named before their reply was kept, as a stop may reach the server ahead of the call it ends.
  stopped: Map<string, { at: number, owner: Promise<string | undefined> }>
}

// A kept reply answers its owner only: a visitor no one can tell apart (no user, no address) owns nothing, so it never matches.
function same(kept: string | undefined, asked: string | undefined): boolean {
  return kept !== undefined && kept === asked
}

const SLOT = Symbol.for('kayjs-ai.kept')

// On the global, so every copy of the library in the process shares the replies.
function slot(): Slot {
  const holder = globalThis as { [SLOT]?: Slot }

  return holder[SLOT] ??= { replies: new Map(), stopped: new Map() }
}

function sweep(now: number): void {
  const { replies, stopped } = slot()

  for (const [key, { at }] of replies) {
    if (now - at > KEPT_MS)
      replies.delete(key)
  }

  for (const [key, { at }] of stopped) {
    if (now - at > KEPT_MS)
      stopped.delete(key)
  }

  // A Map iterates oldest first: the finished replies go before any still under way, oldest first.
  for (const wanted of [true, false]) {
    for (const [key, { ended }] of replies) {
      if (replies.size <= MOST_KEPT)
        return

      if (ended === wanted)
        replies.delete(key)
    }
  }
}

// Keeps a reply that outlives its request under the key its Chat named, so the Chat finds it after a reload: for half an hour, 200 at most, in this process's memory.
export function keep(key: string, reply: Reply, owner: Promise<string | undefined>): void {
  const now = Date.now()
  const { replies, stopped } = slot()

  sweep(now)

  const early = stopped.get(key)

  // A stop that came first, from the same owner, ends the reply before it begins.
  if (early) {
    stopped.delete(key)

    void (async () => {
      if (same(await early.owner, await owner))
        reply.stop()
    })()
  }

  replies.delete(key)
  replies.set(key, { reply, at: now, owner, ended: false, refunds: 0 })
}

export function markEnded(key: string): void {
  const entry = slot().replies.get(key)

  if (entry)
    entry.ended = true
}

// The refund is given, with no await between the check and the count, so parallel resumes cannot exceed the cap.
function mayRefund(entry: Entry): boolean {
  if (entry.refunds >= MOST_REFUNDS)
    return false

  entry.refunds++

  return true
}

// Ends the reply kept under `key` if `owner` kept it, else the one about to be kept under it when the stop came first.
// `owned` is called once the reply found is the owner's, unless the reply already gave its refunds.
export function stopKept(key: string, owner: Promise<string | undefined>, owned?: () => Promise<void>): void {
  sweep(Date.now())

  const entry = slot().replies.get(key)

  if (entry === undefined) {
    slot().stopped.set(key, { at: Date.now(), owner })

    return
  }

  void (async () => {
    if (same(await entry.owner, await owner)) {
      entry.reply.stop()

      if (mayRefund(entry))
        await owned?.()
    }
  })()
}

// The reply kept under `key` for `owner`, as a reply that answers like an empty one if the owner is not the one who kept it.
// `owned` is called once, as soon as the reply found is the owner's and has refunds left, whether it is read or not, and is not waited for.
export function keptFor(key: string, owner: Promise<string | undefined>, empty: Reply, owned?: () => Promise<void>): Reply | undefined {
  sweep(Date.now())

  const entry = slot().replies.get(key)

  if (entry === undefined)
    return undefined

  const target = (async (): Promise<{ reply: Reply }> => {
    if (!same(await entry.owner, await owner))
      return { reply: empty }

    // Not waited for: a store failing to take the attempt back must not delay the reply, and the refund logs its own errors.
    if (mayRefund(entry))
      void owned?.()

    return { reply: entry.reply }
  })()
  const ahead = <Value>(pick: (reply: Reply) => AsyncIterable<Value>): AsyncIterable<Value> => ({
    [Symbol.asyncIterator]: () => {
      let source: AsyncIterator<Value> | undefined

      return {
        async next() {
          source ??= pick((await target).reply)[Symbol.asyncIterator]()

          return source.next()
        },
        async return(value?: unknown) {
          return await source?.return?.(value) ?? { done: true, value: undefined }
        },
      }
    },
  })

  return {
    // eslint-disable-next-line kaynooo/no-then -- the thenable's own `then`, passed through
    then: async (onFulfilled, onRejected) => (await target).reply.then(onFulfilled, onRejected),
    [Symbol.asyncIterator]: () => ahead(reply => reply)[Symbol.asyncIterator](),
    stream: () => ahead(reply => reply.stream()),
    deltas: options => ahead(reply => reply.deltas(options)),
    progress: () => ahead(reply => reply.progress()),
    get calls() {
      return (async () => (await target).reply.calls)()
    },
    get steps() {
      return (async () => (await target).reply.steps)()
    },
    get usage() {
      return (async () => (await target).reply.usage)()
    },
    get finish() {
      return (async () => (await target).reply.finish)()
    },
    resumed: true,
    stop: () => void (async () => {
      (await target).reply.stop()
    })(),
  }
}

export function forgetKept(): void {
  slot().replies.clear()
  slot().stopped.clear()
}
