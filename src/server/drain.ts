// Why a run's signal aborted when the server stopped, as against its own timeout running out.
export const STOPPED = new Error('the server is stopping')

const DEFAULT_GRACE_MS = 3000
// The share of the shutdown timeout a run ignoring its signal may take, so its job is handed back and the hooks still run before the forced exit.
const GRACE_SHARE = 0.4

let grace = DEFAULT_GRACE_MS
const begins = new Set<() => void>()

// How long a stop waits for a run that ignores its signal before leaving it, queues and schedules alike.
export function stopGraceMs(): number {
  return grace
}

// Registers what to do when the stop begins; returns what forgets it.
export function onDrain(begin: () => void): () => void {
  begins.add(begin)

  return () => void begins.delete(begin)
}

// What a stop signal tells at once, before the server waits for its open requests: queues and schedules abort their runs then, so the grace each gives a run ignoring its signal passes beside the others' and beside the requests, not after them one hook at a time. `budgetMs` is the shutdown timeout, which the grace stays well inside.
export function beginDrain(budgetMs: number): void {
  grace = Math.min(DEFAULT_GRACE_MS, budgetMs * GRACE_SHARE)

  for (const begin of begins)
    begin()
}

// Ends the drain `beginDrain` started, once the stop has run its hooks, so a stop that did not end the process leaves the next one the default grace.
export function endDrain(): void {
  grace = DEFAULT_GRACE_MS
}
