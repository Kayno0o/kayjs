import { AsyncLocalStorage } from 'node:async_hooks'

// The last turn each collection's saves, removes and migration write-backs took, which settles once it and every one before it are done. Keyed by the collection's own name, which a loader's write-back knows and an export name may differ from.
const saving = new Map<string, Promise<void>>()

// The collections whose turn the running call holds, so a load it makes meets its own turn and does not wait on it.
const holding = new AsyncLocalStorage<ReadonlySet<string>>()

// Takes the collection's next turn as the call is made, so saves and removes run in the order they were called: `ready` once every earlier one settled, however it ended, `done` passing the turn on.
export function takeTurn(key: string): { ready: Promise<void>, done: () => void } {
  const ready = saving.get(key) ?? Promise.resolve()
  const finished = Promise.withResolvers<void>()
  const turn = (async () => {
    await ready
    await finished.promise
  })()

  saving.set(key, turn)
  // Forgotten once settled, never before: a later call finding no turn would run beside one still pending.
  void (async () => {
    await turn

    if (saving.get(key) === turn)
      saving.delete(key)
  })()

  return { ready, done: finished.resolve }
}

// Runs the work with the collection's turn marked as held by it, for a call that took the turn itself.
export async function holdingTurn<Result>(key: string, work: () => Promise<Result>): Promise<Result> {
  return holding.run(new Set([...holding.getStore() ?? [], key]), work)
}

// Runs the work in the collection's turn, or at once when the caller already holds it, such as a write-back met by a load inside a save.
export async function inTurn<Result>(key: string, work: () => Promise<Result>): Promise<Result> {
  if (holding.getStore()?.has(key))
    return work()

  const turn = takeTurn(key)

  try {
    await turn.ready

    return await holdingTurn(key, work)
  }
  finally {
    turn.done()
  }
}
