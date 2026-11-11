import type { StoredJobState } from './queue'

export function statusOf(failed: boolean, heldUntil: number, now: number): StoredJobState['status'] {
  if (failed)
    return 'failed'

  return heldUntil > now ? 'running' : 'waiting'
}
