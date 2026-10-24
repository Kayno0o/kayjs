// Answers meaning "ask again later": a `local()` write answered with one stays queued, and the server never keeps such an answer for a retry.
export const RETRY_LATER = [408, 425, 429] as const

// How long a replayed write, or the page's read of the server, may take before it counts as offline: it holds the lock every tab and the worker send under.
export const MOST_WAIT_MS = 30_000

// A write the server answers 5xx this many times is rejected, so one that always throws does not hold the queue forever: the page and the worker count on the write.
export const MOST_FAULTS = 5
