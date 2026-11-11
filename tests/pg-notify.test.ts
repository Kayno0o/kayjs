import type { SQL } from 'bun'

import type { JobStore } from '../src/server'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { stringify } from 'devalue'
import { Elysia } from 'elysia'
import { logSink, setLogSink } from '../src/runtime/log'
import { memoryJobs, pgJobs, queue, shutdown } from '../src/server'
import { pgCache } from '../src/server/pg-cache'
import { createDataTables, pgData, pgHandle } from '../src/server/pg-data'
import { pgLive } from '../src/server/pg-live'
import { hear } from '../src/server/pg-notify'
import { pgRooms } from '../src/server/pg-rooms'
import { disposeOwned } from '../src/server/reload'
import { serverStarted, serverStopped } from '../src/server/serving'
import { eventually } from './helpers/eventually'
import { restoreClock, virtualClock } from './helpers/virtual-clock'
import { cleanUpAfterFile, pgIt, postgres, replicas } from './job-stores'

cleanUpAfterFile()

// A server runs in the process, which is when a database is listened on.
beforeEach(serverStarted)
afterEach(() => {
  restoreClock()
  serverStopped()
})

let names = 0

// How many backends of the test database sit in LISTEN.
async function listening(sql: SQL): Promise<number> {
  const rows = await sql<{ count: string }[]>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid() AND state = 'idle' AND query LIKE 'LISTEN%'`

  return Number(rows[0]!.count)
}

// A SQL that listens through `listen` and sends no notification of its own.
function fake(listen: (channel: string, notify: (payload: string) => void, listened?: () => void) => Promise<{ unlisten: () => Promise<void> }>): SQL {
  return Object.assign(async () => [], { listen }) as unknown as SQL
}

async function logged<Result>(work: () => Promise<Result>): Promise<{ result: Result, lines: string[] }> {
  const sink = logSink()
  const lines: string[] = []

  setLogSink((level, message) => void lines.push(`${level}: ${message}`))

  try {
    return { result: await work(), lines }
  }
  finally {
    setLogSink(sink)
  }
}

describe('the notification subscription of a database', () => {
  it('opens one LISTEN for every reader of a database and closes it with the last', async () => {
    const calls = { listen: 0, unlisten: 0 }

    const db = fake(async () => {
      calls.listen++

      return { unlisten: async () => void calls.unlisten++ }
    })

    const subscriptions = await Promise.all([hear(db, 'live', undefined, () => undefined), hear(db, 'cache', undefined, () => undefined), hear(db, 'jobs', 'a', () => undefined)])

    expect(calls).toEqual({ listen: 1, unlisten: 0 })

    await subscriptions[0].stop()
    await subscriptions[0].stop()
    await subscriptions[1].stop()
    expect(calls.unlisten).toBe(0)
    await subscriptions[2].stop()
    expect(calls).toEqual({ listen: 1, unlisten: 1 })

    // A reader arriving later opens it again, as a dev reload's new module does.
    const again = await hear(db, 'live', undefined, () => undefined)

    expect(calls.listen).toBe(2)
    await again.stop()
  })

  it('listens only while a server runs, so a script using a store can exit', async () => {
    serverStopped()

    const calls = { listen: 0, unlisten: 0 }

    const db = fake(async () => {
      calls.listen++

      return { unlisten: async () => void calls.unlisten++ }
    })

    const subscription = await hear(db, 'live', undefined, () => undefined)

    expect(calls.listen).toBe(0)
    serverStarted()
    await eventually(() => expect(calls.listen).toBe(1))
    serverStopped()
    await eventually(() => expect(calls.unlisten).toBe(1))
    serverStarted()
    await eventually(() => expect(calls.listen).toBe(2))
    await subscription.stop()
    expect(calls.unlisten).toBe(2)
  })

  it('wakes only the readers of the kind and name written, and every reader of a kind written without a name', async () => {
    let notify: (payload: string) => void = () => undefined
    const woken: string[] = []

    const db = fake(async (_channel, onNotify) => {
      notify = onNotify

      return { unlisten: async () => undefined }
    })

    const stops = await Promise.all([
      hear(db, 'jobs', 'mails', () => void woken.push('mails')),
      hear(db, 'jobs', 'reports', () => void woken.push('reports')),
      hear(db, 'live', undefined, () => void woken.push('live')),
    ])

    notify('jobs\nmails')
    notify('live')
    notify('jobs\nunknown')
    expect(woken).toEqual(['mails', 'live'])
    notify('jobs')
    expect(woken).toEqual(['mails', 'live', 'mails', 'reports'])

    for (const subscription of stops)
      await subscription.stop()
  })

  it('wakes its readers once more when the subscription is back after a reconnect', async () => {
    let listened: () => void = () => undefined
    let woken = 0

    const db = fake(async (_channel, _notify, onListen) => {
      listened = onListen!

      return { unlisten: async () => undefined }
    })

    const subscription = await hear(db, 'live', undefined, () => void woken++)

    // The start reads once for what was written before it, and so does each return.
    listened()
    expect(woken).toBe(1)
    listened()
    expect(woken).toBe(2)
    await subscription.stop()
  })

  it('logs once why a database that refuses LISTEN is polled, and delivers nothing', async () => {
    const db = fake(async () => {
      throw new Error('permission denied for LISTEN')
    })

    const { result, lines } = await logged(async () => {
      const first = await hear(db, 'live', undefined, () => undefined)
      const second = await hear(db, 'cache', undefined, () => undefined)

      return [first, second]
    })

    expect(result.map(subscription => subscription.delivering())).toEqual([false, false])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('polling only')
    await Promise.all(result.map(async subscription => subscription.stop()))
  })

  it('logs once, and is not delivering, when LISTEN is accepted and no notification comes back', async () => {
    const db = fake(async (_channel, _notify, onListen) => {
      queueMicrotask(() => onListen?.())

      return { unlisten: async () => undefined }
    })

    const { result, lines } = await logged(async () => {
      const subscription = await hear(db, 'live', undefined, () => undefined)

      await Bun.sleep(3300)

      return subscription
    })

    expect(result.delivering()).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('delivered no notification')
    await result.stop()
  })
})

describe('a Postgres database that notifies', () => {
  pgIt('is told by a write of another connection, and is delivering', async () => {
    await postgres()

    const [reader, writer] = replicas(2)
    const store = pgJobs(reader!)
    const woken: number[] = []
    const subscription = await store.listen!('mails', () => void woken.push(1))

    await eventually(() => expect(subscription.delivering()).toBe(true))
    // The start woke it once.
    woken.length = 0
    await pgJobs(writer!).add({ id: crypto.randomUUID(), queue: 'mails', payload: stringify(1), attempts: 0, runAt: Date.now() })
    await eventually(() => expect(woken.length).toBeGreaterThan(0))

    const count = woken.length

    await pgJobs(writer!).add({ id: crypto.randomUUID(), queue: 'other', payload: stringify(1), attempts: 0, runAt: Date.now() })
    await Bun.sleep(200)
    expect(woken).toHaveLength(count)
    await subscription.stop()
  })

  pgIt('wakes its readers for a job released, retried, revived or rewritten', async () => {
    await postgres()

    const [reader, writer] = replicas(2)
    const woken: number[] = []
    const subscription = await pgJobs(reader!).listen!('retries', () => void woken.push(1))
    const store = pgJobs(writer!)
    const id = crypto.randomUUID()

    await store.add({ id, queue: 'retries', payload: stringify(1), attempts: 0, runAt: Date.now() })

    const claimed = await store.claim('retries', Date.now(), Date.now() + 60_000)

    await eventually(() => expect(woken.length).toBeGreaterThan(0))

    for (const step of [
      async () => store.retry(id, Date.now() + 60_000, 'nope', claimed!.heldUntil),
      async () => store.update!(id, { payload: stringify(2), runAt: Date.now() }, { payload: stringify(1), now: Date.now() }),
    ]) {
      const before = woken.length

      await step()
      await eventually(() => expect(woken.length).toBeGreaterThan(before))
    }

    // A failed job leaves the queue: reviving it is what brings it back.
    await store.fail(id, 'gave up')

    const revived = woken.length

    await store.revive!(id, Date.now())
    await eventually(() => expect(woken.length).toBeGreaterThan(revived))

    const before = woken.length
    const held = await store.claim('retries', Date.now(), Date.now() + 60_000)

    await store.release!(id, held!.heldUntil!)
    await eventually(() => expect(woken.length).toBeGreaterThan(before))
    await subscription.stop()
  })

  pgIt('wakes its readers again after the connection it listens on was killed', async () => {
    const { sql } = await postgres()
    const [reader] = replicas(1)
    const woken: number[] = []
    const subscription = await pgJobs(reader!).listen!('killed', () => void woken.push(1))

    await eventually(() => expect(subscription.delivering()).toBe(true))
    woken.length = 0

    // Every other session of the database goes, the listening one included.
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`
    await eventually(() => expect(woken.length).toBeGreaterThan(0))

    // And a write after it is heard again.
    const before = woken.length

    await eventually(async () => {
      await sql`SELECT pg_notify('kay_wake', 'jobs' || chr(10) || 'killed')`
      expect(woken.length).toBeGreaterThan(before)
    })
    await subscription.stop()
  })

  pgIt('starts an idle queue on the job another process added within a second, though it would look again in seconds', async () => {
    await postgres()

    const [worker, producer] = replicas(2)
    const name = `notified-${++names}`
    const ran = Promise.withResolvers<number>()

    const jobs = queue<number>(name, async (payload) => {
      ran.resolve(payload)
    }, { store: pgJobs(worker!) })

    const app = new Elysia().use(jobs).listen(0)

    try {
      // The queue looks at the store after 1 s, then 2 s, then 4 s while idle: a job added at 1.5 s waits for the look at 3 s unless it is told.
      await Bun.sleep(1500)

      const added = performance.now()

      await pgJobs(producer!).add({ id: crypto.randomUUID(), queue: name, payload: stringify(7), attempts: 0, runAt: Date.now() })
      expect(await ran.promise).toBe(7)
      expect(performance.now() - added).toBeLessThan(700)
    }
    finally {
      await shutdown(app)
    }
  }, 15_000)

  it('asks the store to listen again when it could not at the start, and stops when the queue does', async () => {
    const calls = { listen: 0, stop: 0 }
    const sink = logSink()

    setLogSink(() => undefined)

    const store: JobStore = {
      ...memoryJobs(),
      listen: async () => {
        if (++calls.listen === 1)
          throw new Error('the database is down')

        return { stop: async () => void calls.stop++, delivering: () => true }
      },
    }

    const jobs = queue<number>(`resubscribe-${++names}`, async () => undefined, { store })
    const app = new Elysia().use(jobs).listen(0)

    try {
      await eventually(() => expect(calls.listen).toBe(2), 8000)
    }
    finally {
      await shutdown(app)
      setLogSink(sink)
    }

    expect(calls.stop).toBe(1)
  }, 15_000)

  pgIt('stops listening with the queue, and a second start listens once', async () => {
    const { sql } = await postgres()
    const [worker] = replicas(1)
    const name = `closing-${++names}`
    const jobs = queue<number>(name, async () => undefined, { store: pgJobs(worker!) })

    const app = new Elysia().use(jobs).listen(0)

    await eventually(async () => expect(await listening(sql)).toBe(1))
    await shutdown(app)
    await eventually(async () => expect(await listening(sql)).toBe(0))
  }, 15_000)

  pgIt('releases its LISTEN connection when pgData is closed', async () => {
    const { sql, url } = await postgres()
    const data = pgData(url)

    try {
      await data.live.entries()
      data.live.subscribe(() => undefined)
      await eventually(async () => expect(await listening(sql)).toBe(1))
    }
    finally {
      await data.close()
    }

    await eventually(async () => expect(await listening(sql)).toBe(0))
  }, 15_000)

  pgIt('releases its LISTEN connection when a dev reload closes the pgJobs it opened from a URL', async () => {
    const { sql, url } = await postgres()
    const previous = process.env.KAY_DEV_CODE

    process.env.KAY_DEV_CODE = '1'

    try {
      const subscription = await pgJobs(url).listen!(`reloaded-${++names}`, () => undefined)

      await eventually(async () => expect(await listening(sql)).toBe(1))
      await disposeOwned(new Set([import.meta.path]))
      await eventually(async () => expect(await listening(sql)).toBe(0))
      await subscription.stop()
    }
    finally {
      if (previous === undefined)
        delete process.env.KAY_DEV_CODE
      else
        process.env.KAY_DEV_CODE = previous
    }
  }, 15_000)

  pgIt('opens no LISTEN for a lazy queue until it is activated, then starts it on a notification', async () => {
    const { sql } = await postgres()
    const [worker, producer] = replicas(2)
    const name = `lazy-${++names}`
    const ran = Promise.withResolvers<number>()

    const jobs = queue<number>(name, async (payload) => {
      ran.resolve(payload)
    }, { store: pgJobs(worker!), lazy: true })

    const app = new Elysia().use(jobs).listen(0)

    try {
      await Bun.sleep(300)
      expect(await listening(sql)).toBe(0)
      jobs.activate()
      await eventually(async () => expect(await listening(sql)).toBe(1))
      // Past the looks at 1 s and 3 s the next is at 7 s: only a notification starts it sooner.
      await Bun.sleep(3500)

      const added = performance.now()

      await pgJobs(producer!).add({ id: crypto.randomUUID(), queue: name, payload: stringify(9), attempts: 0, runAt: Date.now() })
      expect(await ran.promise).toBe(9)
      expect(performance.now() - added).toBeLessThan(1000)
    }
    finally {
      await shutdown(app)
    }
  }, 20_000)

  pgIt('lets a live value set in one process reach another in a quiet stretch with its timers stopped', async () => {
    const { sql } = await postgres()

    await createDataTables(sql)

    const clock = virtualClock()
    const [readerSql, writerSql] = replicas(2)
    const reader = pgLive(pgHandle(readerSql!))
    const writer = pgLive(pgHandle(writerSql!))
    const heard: string[] = []

    await reader.entries()
    await writer.entries()
    reader.subscribe((id, key, text) => void heard.push(`${id}/${key}/${text}`))
    await clock.advance(150)

    // No poll fires on its own: only the notification can bring the read.
    await eventually(async () => {
      await writer.set('app:room', 'a', '[1]')
      await clock.advance(150)
      expect(heard).toContain('app:room/a/[1]')
    })
    reader.stop?.()
    writer.stop?.()
  })

  pgIt('lets a room message and a member of one process reach another with its timers stopped', async () => {
    const { sql } = await postgres()

    await createDataTables(sql)

    const clock = virtualClock()
    const [readerSql, writerSql] = replicas(2)
    const reader = pgRooms(pgHandle(readerSql!))
    const writer = pgRooms(pgHandle(writerSql!))
    const heard: string[] = []

    reader.subscribe((room, text) => void heard.push(`${room}/${text}`))
    reader.members('lobby')
    await clock.advance(150)

    // No poll fires on its own: only the notification can bring the read.
    await eventually(async () => {
      writer.publish('lobby', 'hi', {})
      await clock.advance(150)
      expect(heard).toContain('lobby/hi')
    })

    writer.add('lobby', 'tab-1', 'ada')
    await eventually(async () => {
      await clock.advance(150)
      expect(reader.members('lobby')).toEqual(['ada'])
    })

    writer.remove('lobby', 'tab-1')
    await eventually(async () => {
      await clock.advance(150)
      expect(reader.members('lobby')).toEqual([])
    })

    await reader.close?.()
    await writer.close?.()
  })

  // A replica holding a member, its poll asleep at the idle rate once notifications are known to arrive.
  async function sleepingReader() {
    const { sql } = await postgres()

    await createDataTables(sql)

    const clock = virtualClock()
    const [readerSql, writerSql] = replicas(2)
    const reader = pgRooms(pgHandle(readerSql!))
    const writer = pgRooms(pgHandle(writerSql!))

    reader.add('lobby', 'tab-1', 'ada')

    for (let second = 0; second < 90; second++)
      await clock.advance(1000, true)

    return { clock, reader, writer, writerSql: writerSql! }
  }

  pgIt('hears a message published right after a replica holding a member subscribes, its poll asleep', async () => {
    const { clock, reader, writer } = await sleepingReader()
    const heard: string[] = []

    reader.subscribe((room, text) => void heard.push(`${room}/${text}`))
    // The subscription takes where the messages stand, then the writer publishes after it.
    await Bun.sleep(300)
    writer.publish('lobby', 'gap', {})
    await eventually(async () => {
      await clock.advance(150, true)
      expect(heard).toContain('lobby/gap')
    })

    await reader.close?.()
    await writer.close?.()
  })

  pgIt('delivers a message whose notification was lost at the fallback poll at the latest', async () => {
    const { clock, reader, writer, writerSql } = await sleepingReader()
    const heard: string[] = []

    reader.subscribe((room, text) => void heard.push(`${room}/${text}`))
    await Bun.sleep(300)
    await writerSql.unsafe(`INSERT INTO kay_room_messages (room, text, process, at) VALUES ('lobby', 'lost', 'elsewhere', floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint)`)
    await eventually(async () => {
      await clock.advance(31_000, true)
      expect(heard).toContain('lobby/lost')
    })

    await reader.close?.()
    await writer.close?.()
  })

  pgIt('lets a cache invalidation published in one process reach another with its timers stopped', async () => {
    const { sql } = await postgres()

    await createDataTables(sql)

    const clock = virtualClock()
    const [readerSql, writerSql] = replicas(2)
    const reader = pgCache(pgHandle(readerSql!))
    const writer = pgCache(pgHandle(writerSql!))
    const heard: string[] = []

    const published = await hear(readerSql!, 'cache', undefined, () => void heard.push('told'))

    await eventually(() => expect(published.delivering()).toBe(true))
    await writer.publish!('page:/b')
    await eventually(() => expect(heard).toContain('told'))
    heard.length = 0
    await published.stop()
    reader.subscribe?.(message => void heard.push(message))
    await clock.advance(150, true)
    // The first poll of the reader starts after the events already there.
    await eventually(async () => {
      await clock.advance(150, true)
      expect(await reader.keys()).toEqual([])
    })

    // Another process's event: the stores of one test process share their origin, which a store hears nothing from.
    await eventually(async () => {
      await writerSql!.unsafe(`WITH published AS (INSERT INTO kay_events (origin, message, at) VALUES ('elsewhere', '{"keys":["a"]}', floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint) RETURNING id) SELECT pg_notify('kay_wake', 'cache') FROM published`)
      await clock.advance(150, true)
      expect(heard).toContain('{"keys":["a"]}')
    })
  })

  pgIt('keeps polling when a notification is lost', async () => {
    const { sql } = await postgres()

    await createDataTables(sql)

    const [readerSql, writerSql] = replicas(2)
    const reader = pgLive(pgHandle(readerSql!))
    const heard: string[] = []

    await reader.entries()
    reader.subscribe((id, key, text) => void heard.push(`${id}/${key}/${text}`))

    // A row and its event written with no notification, as a lost one leaves it.
    await writerSql!.unsafe(`INSERT INTO kay_live (id, key, value) VALUES ('app:lost', 'k', '[3]') ON CONFLICT (id, key) DO UPDATE SET value = excluded.value`)
    await writerSql!.unsafe(`INSERT INTO kay_live_events (origin, id, key, at) VALUES ('elsewhere', 'app:lost', 'k', floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint)`)
    await eventually(() => expect(heard).toContain('app:lost/k/[3]'), 5000)
    reader.stop?.()
  })
})
