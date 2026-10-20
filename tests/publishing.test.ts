import type { Collection } from '../src/content'
import type { LogLevel } from '../src/runtime/log'
import type { ServedPage } from '../src/server/render'
import { afterEach, describe, expect, it, jest } from 'bun:test'
import { contentKey, PUBLISH_TIMES } from '../src/content'
import { ALL_READS, onKeysInvalidated } from '../src/runtime/cache'
import { logSink, setLogSink } from '../src/runtime/log'
import { watchPublishing } from '../src/server/publishing'

const NOW = Date.parse('2026-10-19T12:00:00Z')
const HOUR = 3_600_000
const RETRY = 60_000

type Dates = () => Promise<number[]>

// A collection that only gives the dates `publishAt` reads, as the loader behind them would.
function dated(name: string, dates: Dates): Collection<unknown> {
  return { name, options: { publishAt: 'at' }, [PUBLISH_TIMES]: dates } as unknown as Collection<unknown>
}

const page = (renderedAt: number, ...reads: (string | typeof ALL_READS)[]) => ({ renderedAt, reads }) as unknown as ServedPage

// Lets the promise jobs a timer started settle, as fake timers do not.
async function settle() {
  for (let turn = 0; turn < 20; turn++)
    await Promise.resolve()
}

async function advance(by: number) {
  jest.advanceTimersByTime(by)
  await settle()
}

const watchers: Awaited<ReturnType<typeof watchPublishing>>[] = []
const previousSink = logSink()
const logged: { level: LogLevel, message: string }[] = []

function sunk() {
  logged.length = 0
  setLogSink((level, message) => void logged.push({ level, message }))
}

async function watch(...collections: Collection<unknown>[]) {
  const publishing = await watchPublishing(collections)

  watchers.push(publishing)

  return publishing
}

afterEach(() => {
  for (const publishing of watchers.splice(0))
    publishing.stop()

  jest.useRealTimers()

  if (previousSink)
    setLogSink(previousSink)
  else
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('kay.log')]
})

describe('watchPublishing at boot', () => {
  it('logs a failed boot read once and catches up when the retry reads the dates', async () => {
    jest.useFakeTimers({ now: NOW })
    sunk()

    let failing = true
    const talks = dated('talks', async () => {
      if (failing)
        throw new Error('the database is down')

      return [NOW - HOUR]
    })
    const publishing = await watch(talks)

    await settle()
    expect(logged.filter(entry => entry.level === 'error')).toHaveLength(1)
    expect(publishing.passed(page(NOW - 2 * HOUR, contentKey('talks')))).toBe(false)

    let settled = false

    void (async () => {
      await publishing.caughtUp
      settled = true
    })()
    await settle()
    expect(settled).toBe(false)
    failing = false
    await advance(RETRY)
    expect(settled).toBe(true)
    expect(publishing.passed(page(NOW - 2 * HOUR, contentKey('talks')))).toBe(true)
    expect(publishing.passed(page(NOW, contentKey('talks')))).toBe(false)
    expect(logged.filter(entry => entry.level === 'error')).toHaveLength(1)
  })

  it('catches up a date that passed while the loader was down, not only the ones passed at boot', async () => {
    jest.useFakeTimers({ now: NOW })
    sunk()

    let failing = true
    const publishing = await watch(dated('talks', async () => {
      if (failing)
        throw new Error('the database is down')

      return [NOW + 30_000]
    }))

    await settle()
    await advance(45_000)
    failing = false
    await advance(RETRY)
    expect(publishing.passed(page(NOW, contentKey('talks')))).toBe(true)
    expect(publishing.passed(page(NOW + RETRY, contentKey('talks')))).toBe(false)
    expect(publishing.passed(page(NOW, ALL_READS))).toBe(true)
  })

  it('retries again while the loader keeps failing, logging each failure once', async () => {
    jest.useFakeTimers({ now: NOW })
    sunk()

    let failures = 2
    const publishing = await watch(dated('talks', async () => {
      if (failures-- > 0)
        throw new Error('the database is down')

      return [NOW - HOUR]
    }))

    await settle()
    await advance(RETRY)
    expect(logged).toHaveLength(2)
    expect(publishing.passed(page(NOW - 2 * HOUR, contentKey('talks')))).toBe(false)
    await advance(RETRY)
    expect(logged).toHaveLength(2)
    expect(publishing.passed(page(NOW - 2 * HOUR, contentKey('talks')))).toBe(true)
  })

  it('holds the start of the server for a second at most while the first read is pending', async () => {
    jest.useFakeTimers({ now: NOW })

    const release = Promise.withResolvers<number[]>()
    let started = false
    const starting = (async () => {
      await watch(dated('talks', async () => release.promise))
      started = true
    })()

    await settle()
    expect(started).toBe(false)
    await advance(999)
    expect(started).toBe(false)
    await advance(1)
    expect(started).toBe(true)
    await starting
    release.resolve([NOW - HOUR])
    await settle()
  })

  it('knows the dates that passed once a slow first read ends', async () => {
    jest.useFakeTimers({ now: NOW })

    const release = Promise.withResolvers<number[]>()
    const starting = watch(dated('talks', async () => release.promise))

    await advance(1000)

    const publishing = await starting

    expect(publishing.passed(page(NOW - 2 * HOUR, contentKey('talks')))).toBe(false)
    release.resolve([NOW - HOUR])
    await settle()
    expect(publishing.passed(page(NOW - 2 * HOUR, contentKey('talks')))).toBe(true)
  })

  it('stops with a read still pending, then takes no date from it', async () => {
    jest.useFakeTimers({ now: NOW })

    const release = Promise.withResolvers<number[]>()
    const starting = watch(dated('talks', async () => release.promise))

    await advance(1000)

    const publishing = await starting

    publishing.stop()
    release.resolve([NOW - HOUR])
    await settle()
    expect(publishing.passed(page(NOW - 2 * HOUR, contentKey('talks')))).toBe(false)
  })

  it('refreshes once a fired read fails and a retry reads the dates', async () => {
    jest.useFakeTimers({ now: NOW })
    sunk()

    let failing = false
    let refreshed = 0
    const stopHearing = onKeysInvalidated((matches) => {
      if (matches(contentKey('talks')))
        refreshed++

      return []
    })

    try {
      await watch(dated('talks', async () => {
        if (failing)
          throw new Error('the database is down')

        return [NOW + 10_000]
      }))
      await settle()
      failing = true
      await advance(10_000)
      expect(refreshed).toBe(0)
      failing = false
      await advance(RETRY)
      expect(refreshed).toBe(1)
    }
    finally {
      stopHearing()
    }
  })

  it('watches nothing for collections with no publishAt', async () => {
    const publishing = await watchPublishing([{ name: 'posts', options: {} } as unknown as Collection<unknown>])

    expect(publishing.passed(page(0, contentKey('posts')))).toBe(false)
  })
})
