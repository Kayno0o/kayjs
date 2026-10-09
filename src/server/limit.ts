// Runs at most this many tasks at once, the others waiting their turn in order.
export function limiter(most: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []

  return async (task) => {
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
}
