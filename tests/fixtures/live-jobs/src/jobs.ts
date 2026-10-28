import { memoryJobs, queue } from 'kay/server'

// What a test opens to let a running scan finish, one gate per run in the order they started.
export const gates: PromiseWithResolvers<void>[] = []

export const store = memoryJobs()

export const scans = queue<{ target: string, token: string }>('scans', async () => {
  const gate = Promise.withResolvers<void>()

  gates.push(gate)
  await gate.promise
}, { store, live: ({ target }) => ({ target }), attempts: 1 })

// A queue whose jobs no page may list.
export const quiet = queue<{ n: number }>('quiet', () => undefined, { store })
