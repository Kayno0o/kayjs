import type { Reply } from './types'

const KEPT_MS = 30 * 60_000
const MOST_KEPT = 200

interface Slot {
  replies: Map<string, { reply: Reply, at: number }>
  // Ids a stop named before their reply was kept, as a stop may reach the server ahead of the call it ends.
  stopped: Map<string, number>
}

const SLOT = Symbol.for('kayjs-ai.kept')

// On the global, so every copy of the library in the process shares the replies.
function slot(): Slot {
  const holder = globalThis as { [SLOT]?: Slot }

  return holder[SLOT] ??= { replies: new Map(), stopped: new Map() }
}

function sweep(now: number): void {
  const { replies, stopped } = slot()

  for (const [id, { at }] of replies) {
    if (now - at > KEPT_MS)
      replies.delete(id)
  }

  for (const [id, at] of stopped) {
    if (now - at > KEPT_MS)
      stopped.delete(id)
  }

  // A Map iterates oldest first, so the overflow is the oldest.
  for (const id of replies.keys()) {
    if (replies.size <= MOST_KEPT)
      break

    replies.delete(id)
  }
}

// Keeps a reply that outlives its request under the id its Chat named, so the Chat finds it after a reload: for half an hour, 200 at most, in this process's memory.
export function keep(id: string, reply: Reply): void {
  const now = Date.now()
  const { replies, stopped } = slot()

  sweep(now)

  // A stop that came first ends the reply before it begins.
  if (stopped.delete(id)) {
    reply.stop()

    return
  }

  replies.delete(id)
  replies.set(id, { reply, at: now })
}

// Ends the reply kept under `id`, or the one about to be kept under it when the stop came first.
export function stopKept(id: string | undefined): void {
  if (id === undefined)
    return

  const found = kept(id)

  if (found)
    found.stop()
  else
    slot().stopped.set(id, Date.now())
}

export function kept(id: string | undefined): Reply | undefined {
  sweep(Date.now())

  return id === undefined ? undefined : slot().replies.get(id)?.reply
}

export function forgetKept(): void {
  slot().replies.clear()
  slot().stopped.clear()
}
