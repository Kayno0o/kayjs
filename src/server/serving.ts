// Whether a server runs in this process, which what keeps a connection open only to be told of writes waits for: Bun does not let a process exit while one listens, so a script or a build that used a store never hangs on it.
let running = 0
const changes = new Set<() => void>()

export const isServing = (): boolean => running > 0

// Calls `run` when the first server starts and when the last one stops; returns what forgets it.
export function onServingChange(run: () => void): () => void {
  changes.add(run)

  return () => void changes.delete(run)
}

// A server started in this process, an Elysia app with `kay`'s boot or a queue's workers.
export function serverStarted(): void {
  running++

  if (running === 1)
    notify()
}

export function serverStopped(): void {
  if (running === 0)
    return

  running--

  if (running === 0)
    notify()
}

function notify(): void {
  for (const run of changes)
    run()
}
