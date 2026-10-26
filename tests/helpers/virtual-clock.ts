import { pollClock } from '../../src/runtime/poll-backoff'

const real = { ...pollClock }

export function restoreClock(): void {
  Object.assign(pollClock, real)
}

// A clock the test moves: a minute of polling takes no time, and every timer that fires is counted.
export function virtualClock() {
  let now = 1_000_000
  let next = 0
  let fired = 0

  const timers = new Map<number, { at: number, run: () => void }>()

  // Waits for the poll that just fired to end and arm the next, as a database answers in its own time.
  const rearmed = async (expected: number) => {
    for (let waited = 0; timers.size < expected && waited < 2000; waited += 5)
      await Bun.sleep(5)
  }

  pollClock.now = () => now
  pollClock.setTimeout = (run, ms) => {
    timers.set(++next, { at: now + ms, run })

    return next
  }
  pollClock.clearTimeout = (timer) => {
    timers.delete(timer as number)
  }

  return {
    fired: () => fired,
    reset() {
      fired = 0
    },
    pending: () => timers.size,
    // Fires the timers due within `ms`, in order; with `slow`, waits after each (up to two seconds) for the poll to end and arm the next, as a database answers in its own time.
    async advance(ms: number, slow = false) {
      const end = now + ms

      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]

        if (due === undefined)
          break

        const expected = timers.size

        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        fired++
        due[1].run()

        if (slow)
          await rearmed(expected)
      }

      now = end
    },
  }
}
