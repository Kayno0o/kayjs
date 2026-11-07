// Runs the callbacks one after the other, each one even when an earlier threw, and throws the first error once all have run: a deprecated hook still hears what its new name heard, and the app sees the failure that came first.
export function hear(...calls: (() => unknown)[]): void {
  let failure: { error: unknown } | undefined

  for (const call of calls) {
    try {
      call()
    }
    catch (error) {
      failure ??= { error }
    }
  }

  if (failure)
    throw failure.error
}
