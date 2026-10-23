// How the stores that read what other processes wrote slow down while nothing happens: they poll at the base rate while there is activity, and after `QUIET_POLLS` empty reads the delay doubles up to `MAX_IDLE_MS`, so an idle server does not keep a database awake.
// A write of this process, a new watcher or the first use of a store snaps it back to the base rate; what another process writes is heard within `MAX_IDLE_MS` at the latest.
export const QUIET_POLLS = 8
export const MAX_IDLE_MS = 5000

// The delay before the next read, after `quiet` reads in a row that heard nothing.
export function delayAfter(every: number, quiet: number): number {
  return quiet < QUIET_POLLS ? every : Math.min(MAX_IDLE_MS, every * 2 ** (quiet - QUIET_POLLS + 1))
}

// The clock the pollers run on, which a test replaces to move a minute in no time.
export const pollClock = {
  now: (): number => Date.now(),
  setTimeout(run: () => void, ms: number): unknown {
    const timer = setTimeout(run, ms)

    timer.unref()

    return timer
  },
  clearTimeout(timer: unknown): void {
    clearTimeout(timer as ReturnType<typeof setTimeout>)
  },
}

export interface PollLoop {
  stop: () => void
  // Back to the base rate, with the next read at most `every` away.
  wake: () => void
  // While held, the base rate is kept however quiet the reads are: a watcher waits on the next change.
  hold: (held: boolean) => void
}

// Calls `poll` every `every` ms, slower while it answers false and is not held; `poll` handles its own failures.
export function pollLoop(every: number, poll: () => boolean | void): PollLoop {
  let quiet = 0
  let stopped = false
  let timer: unknown
  let due = 0
  let running = false
  let held = false

  const arm = (ms: number) => {
    pollClock.clearTimeout(timer)
    due = pollClock.now() + ms
    timer = pollClock.setTimeout(run, ms)
  }

  function run() {
    running = true

    const heard = poll() === true

    running = false
    quiet = heard ? 0 : quiet + 1

    if (!stopped)
      arm(held ? every : delayAfter(every, quiet))
  }

  arm(every)

  const wake = () => {
    quiet = 0

    if (!stopped && !running && due - pollClock.now() > every)
      arm(every)
  }

  return {
    stop() {
      stopped = true
      pollClock.clearTimeout(timer)
    },
    wake,
    hold(on) {
      held = on

      if (on)
        wake()
    },
  }
}
