// What the server counts for `metrics`, in plain numbers any module may bump: a cached value read, a scheduled run settled.
export const cacheReads = { hit: 0, miss: 0 }

// Scheduled runs by job label and how each ended, the labels the app's own schedules give so the series stay few.
export const jobRuns = new Map<string, { ok: number, failed: number, skipped: number }>()

export function countJobRun(label: string, result: 'ok' | 'failed' | 'skipped'): void {
  let runs = jobRuns.get(label)

  if (runs === undefined)
    jobRuns.set(label, runs = { ok: 0, failed: 0, skipped: 0 })

  runs[result]++
}

// Runs of each queue and workflow (`workflow:<name>`) by how each ended: done, put back for a retry after a failed attempt, or kept as failed after the last one.
export const queueRuns = new Map<string, { ok: number, retried: number, failed: number }>()

export function countQueueRun(queue: string, result: 'ok' | 'retried' | 'failed'): void {
  let runs = queueRuns.get(queue)

  if (runs === undefined)
    queueRuns.set(queue, runs = { ok: 0, retried: 0, failed: 0 })

  runs[result]++
}

// The pattern of the page a request was answered by, which names it better than the router's `/shop/:p2`.
export const pageRoutes = new WeakMap<Request, string>()
