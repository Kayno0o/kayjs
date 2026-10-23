// What a stop signal tells at once, before the server waits for its open requests: queues and schedules abort their runs then, so the grace each gives a run ignoring its signal passes beside the others' and beside the requests, not after them one hook at a time.
const begins = new Set<() => void>()

// Registers what to do when the stop begins; returns what forgets it.
export function onDrain(begin: () => void): () => void {
  begins.add(begin)

  return () => void begins.delete(begin)
}

export function beginDrain(): void {
  for (const begin of begins)
    begin()
}
