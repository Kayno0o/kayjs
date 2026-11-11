import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { pollClock } from 'kay/library'
import { watcher } from '../src/loaders/shared'

interface Timer {
  run: () => void
  ms: number
  cleared: boolean
}

const real = { ...pollClock }
let timers: Timer[] = []
let count = 0

beforeEach(() => {
  timers = []
  pollClock.setTimeout = (run, ms) => {
    const timer = { run, ms, cleared: false }

    timers.push(timer)

    return timer
  }
  pollClock.clearTimeout = (timer) => {
    if (timer !== undefined)
      (timer as Timer).cleared = true
  }
})

afterEach(() => {
  Object.assign(pollClock, real)
})

// The delay of the look that is armed now.
const armed = () => timers.findLast(timer => !timer.cleared)?.ms

// Runs the armed look and lets it finish, returning the delay it armed next.
async function look(): Promise<number | undefined> {
  const timer = timers.findLast(found => !found.cleared)!

  timer.cleared = true
  timer.run()
  await Bun.sleep(0)

  return armed()
}

// A fresh collection name each test, as a watcher is told apart by it.
const fresh = () => `backoff-${++count}`

describe('the watcher of a loader backs off while nothing changes', () => {
  test('looks at the base rate eight times, then every doubling delay up to five seconds', async () => {
    const watching = watcher(fresh(), 'scope', '1s', '1s', () => 'same')

    await watching.start()
    expect(armed()).toBe(1000)

    const delays: (number | undefined)[] = []

    for (let index = 0; index < 11; index++)
      delays.push(await look())

    expect(delays).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 1000, 2000, 4000, 5000, 5000])
  })

  test('goes back to the base rate on a change, and on a save of this process', async () => {
    let signature = 'a'
    const watching = watcher(fresh(), 'scope', '1s', '1s', () => signature)

    await watching.start()

    for (let index = 0; index < 12; index++)
      await look()

    expect(armed()).toBe(5000)
    signature = 'b'
    expect(await look()).toBe(1000)

    for (let index = 0; index < 12; index++)
      await look()

    expect(armed()).toBe(5000)
    await watching.settle()
    expect(armed()).toBe(1000)
  })

  test('never looks sooner than the interval the app asked for', async () => {
    const watching = watcher(fresh(), 'scope', '20s', '1s', () => 'same')

    await watching.start()

    const delays: (number | undefined)[] = []

    for (let index = 0; index < 12; index++)
      delays.push(await look())

    expect(new Set(delays)).toEqual(new Set([20_000]))
  })

  test('keeps looking after a look that failed', async () => {
    let failing = false
    const watching = watcher(fresh(), 'scope', '1s', '1s', () => {
      if (failing)
        throw new Error('database down')

      return 'same'
    })

    await watching.start()
    failing = true
    expect(await look()).toBe(1000)
    failing = false
    expect(await look()).toBe(1000)
  })

  test('a watcher replaced while it starts leaves no timer and no subscription', async () => {
    const name = fresh()
    let release = () => undefined as void
    let unsubscribed = 0
    const slow = async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })

      return { delivering: () => true, stop: async () => void unsubscribed++ }
    }
    const first = watcher(name, 'scope', '1s', '1s', () => 'same', slow)
    const starting = first.start()

    await watcher(name, 'scope', '1s', '1s', () => 'same').start()
    release()
    await starting
    await Bun.sleep(0)
    expect(timers.filter(timer => !timer.cleared)).toHaveLength(1)
    expect(unsubscribed).toBe(1)
  })

  test('stops looking when a watcher of the same collection replaces it', async () => {
    const name = fresh()
    const first = watcher(name, 'scope', '1s', '1s', () => 'same')
    const second = watcher(name, 'scope', '1s', '1s', () => 'same')

    await first.start()

    const firstTimer = timers.findLast(timer => !timer.cleared)!

    await second.start()
    expect(firstTimer.cleared).toBe(true)
  })
})

describe('the watcher of a loader whose database says when something was written', () => {
  function listening(delivering: boolean) {
    const heard = { wake: () => undefined as void, stopped: 0 }
    const listen = async (wake: () => void) => {
      heard.wake = wake

      return { delivering: () => delivering, stop: async () => void heard.stopped++ }
    }

    return { heard, listen }
  }

  test('falls back to a look every thirty seconds once notifications arrive', async () => {
    const { listen } = listening(true)
    const watching = watcher(fresh(), 'scope', '2s', '2s', () => 'same', listen)

    await watching.start()
    await Bun.sleep(0)

    const delays: (number | undefined)[] = []

    for (let index = 0; index < 13; index++)
      delays.push(await look())

    expect(delays.at(-1)).toBe(30_000)
    expect(delays.slice(0, 7)).toEqual([2000, 2000, 2000, 2000, 2000, 2000, 2000])
  })

  test('keeps the five second fallback where no notification is known to arrive', async () => {
    const { listen } = listening(false)
    const watching = watcher(fresh(), 'scope', '2s', '2s', () => 'same', listen)

    await watching.start()
    await Bun.sleep(0)

    for (let index = 0; index < 13; index++)
      await look()

    expect(armed()).toBe(5000)
  })

  test('looks at once for a notification, however long it had slept', async () => {
    const { heard, listen } = listening(true)
    let reads = 0
    const watching = watcher(fresh(), 'scope', '2s', '2s', () => `read ${++reads > 100 ? 'late' : 'same'}`, listen)

    await watching.start()
    await Bun.sleep(0)

    for (let index = 0; index < 13; index++)
      await look()

    expect(armed()).toBe(30_000)

    const before = reads

    heard.wake()
    expect(armed()).toBe(0)
    await look()
    expect(reads).toBe(before + 1)
    expect(armed()).toBe(2000)
  })

  test('stops listening when the watcher is replaced', async () => {
    const name = fresh()
    const { heard, listen } = listening(true)
    const first = watcher(name, 'scope', '2s', '2s', () => 'same', listen)

    await first.start()
    await Bun.sleep(0)
    await watcher(name, 'scope', '2s', '2s', () => 'same').start()
    await Bun.sleep(0)
    expect(heard.stopped).toBe(1)
  })
})
