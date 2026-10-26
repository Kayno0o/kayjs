import type { Reply } from './types'

const KEPT_MS = 30 * 60_000
const MOST_KEPT = 200

const replies = new Map<string, { reply: Reply, at: number }>()

function sweep(now: number): void {
  for (const [id, { at }] of replies) {
    if (now - at > KEPT_MS)
      replies.delete(id)
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

  sweep(now)
  replies.delete(id)
  replies.set(id, { reply, at: now })
}

export function kept(id: string | undefined): Reply | undefined {
  sweep(Date.now())

  return id === undefined ? undefined : replies.get(id)?.reply
}

export function forgetKept(): void {
  replies.clear()
}
