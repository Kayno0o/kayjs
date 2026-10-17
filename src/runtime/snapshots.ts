// An `await` block's value that arrives in parts: each value it yields is the whole so far, which `then` renders in place of the last.
// A promise is read as one even when it is iterable too, and a getter that throws reads as no iterable.
export function isSnapshots(value: unknown): value is AsyncIterable<unknown> {
  if (typeof value !== 'object' || value === null || value instanceof Promise)
    return false

  try {
    return typeof (value as Partial<AsyncIterable<unknown>>)[Symbol.asyncIterator] === 'function'
  }
  catch {
    return false
  }
}

export interface SnapshotReader {
  // The last value once the iterable ends, with whether `show` had it already; nothing when it yielded none or was stopped, and rejects as the iterable throws.
  done: Promise<{ value: unknown, shown: boolean } | undefined>
  stop: () => void
}

// Reads an iterable to its end, showing its first value at once and then at most one every `everyMs`, the latest of those that came meanwhile; the last is left to `done`.
export function readSnapshots(source: AsyncIterable<unknown>, everyMs: number, show: (value: unknown) => void): SnapshotReader {
  let iterator: AsyncIterator<unknown> | undefined
  let stopped = false
  let latest: { value: unknown } | undefined
  let unshown = false
  let shownAt = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    clearTimeout(timer)
    timer = undefined

    if (!unshown || stopped)
      return

    unshown = false
    shownAt = performance.now()
    show(latest!.value)
  }

  // Taken here, so an iterable failing to give its iterator fails as one throwing does.
  const read = async (): Promise<{ value: unknown, shown: boolean } | undefined> => {
    try {
      iterator = source[Symbol.asyncIterator]()

      for (;;) {
        const step = await iterator.next()

        if (stopped)
          return undefined

        if (step.done === true)
          return latest && { value: latest.value, shown: !unshown }

        latest = { value: step.value }
        unshown = true

        const wait = shownAt + everyMs - performance.now()

        if (wait <= 0)
          flush()
        else
          timer ??= setTimeout(flush, wait)

        // What `show` did may have stopped it.
        if (stopped)
          return undefined
      }
    }
    catch (error) {
      // Stopped, an iterator aborting its pending part on `return()` rejects it: nothing waits for it any more.
      if (stopped)
        return undefined

      throw error
    }
    finally {
      clearTimeout(timer)
    }
  }

  return {
    done: read(),
    stop() {
      if (stopped)
        return

      stopped = true
      clearTimeout(timer)

      // Not awaited: an async generator waiting on its next value only returns once it has one.
      try {
        const returned = iterator?.return?.()

        if (returned)
          void Promise.allSettled([returned])
      }
      // An iterator whose `return` throws is given up on all the same.
      catch {}
    },
  }
}

// What a promise resolves to, or the last part of an iterable, which ends with nothing when it yields none.
export async function lastSnapshot(source: Promise<unknown> | AsyncIterable<unknown>): Promise<{ value: unknown } | undefined> {
  if (!isSnapshots(source))
    return { value: await source }

  let last: { value: unknown } | undefined

  for await (const value of source)
    last = { value }

  return last
}
