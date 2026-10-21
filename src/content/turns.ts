// The last turn each collection's saves, removes and migration write-backs took, which settles once it and every one before it are done. Keyed by the collection's own name, which a loader's write-back knows and an export name may differ from.
const saving = new Map<string, Promise<void>>()

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

// The collection's turn when no save or remove holds or awaits it, else nothing: a write-back never waits on an editor's save, which may itself be reading the collection.
export function takeFreeTurn(key: string): { done: () => void } | undefined {
  return saving.has(key) ? undefined : takeTurn(key)
}
