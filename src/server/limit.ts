export interface TaskLimiter {
  <T>(task: () => Promise<T>): Promise<T>
  // How many tasks wait for a slot.
  readonly waiting: number
}

// Runs at most this many tasks at once, the others waiting their turn in order.
export function limiter(most: number): TaskLimiter {
  let active = 0
  const waiting: (() => void)[] = []

  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= most)
      await new Promise<void>(resolve => waiting.push(resolve))
    else
      active++

    try {
      return await task()
    }
    finally {
      // A waiting task takes over the slot, so `active` only drops once none waits.
      const next = waiting.shift()

      if (next)
        next()
      else
        active--
    }
  }

  return Object.defineProperty(run, 'waiting', { get: () => waiting.length }) as TaskLimiter
}
