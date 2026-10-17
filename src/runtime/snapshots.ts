// An `await` block's value that arrives in parts: each value it yields is the whole so far, which `then` renders in place of the last.
export function isSnapshots(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as Partial<AsyncIterable<unknown>>)[Symbol.asyncIterator] === 'function'
}

export interface SnapshotReader {
  // The last value once the iterable ends, nothing when it yielded none or was stopped; rejects as the iterable throws.
  done: Promise<{ value: unknown } | undefined>
  stop: () => void
}

// Reads an iterable to its end, showing its first value at once and then at most one every `everyMs`, the latest of those that came meanwhile; the last is left to `done`.
export function readSnapshots(source: AsyncIterable<unknown>, everyMs: number, show: (value: unknown) => void): SnapshotReader {
  const iterator = source[Symbol.asyncIterator]()
  let stopped = false
  let latest: { value: unknown } | undefined
  let unshown = false
  let shownAt = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    timer = undefined

    if (!unshown || stopped)
      return

    unshown = false
    shownAt = Date.now()
    show(latest!.value)
  }

  const read = async (): Promise<{ value: unknown } | undefined> => {
    try {
      for (;;) {
        const step = await iterator.next()

        if (stopped)
          return undefined

        if (step.done === true)
          return latest

        latest = { value: step.value }
        unshown = true

        const wait = shownAt + everyMs - Date.now()

        if (wait <= 0)
          flush()
        else
          timer ??= setTimeout(flush, wait)
      }
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
        const returned = iterator.return?.()

        if (returned)
          void Promise.allSettled([returned])
      }
      catch {}
    },
  }
}
