import type { SQL } from 'bun'
import type { PgHandle } from '../src/server/pg-data'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { logSink, setLogSink } from '../src/runtime/log'
import { pgHandle } from '../src/server/pg-data'
import { pgRooms } from '../src/server/pg-rooms'
import { memoryRooms, rooms, sqliteRooms } from '../src/server/rooms'
import { cleanUpAfterFile, pgDescribe, pgIt, postgres, replicas } from './job-stores'

cleanUpAfterFile()

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

function connection() {
  const received: string[] = []

  return { received, raw: { sendText: (text: string) => void received.push(text) } }
}

async function until(ready: () => boolean): Promise<void> {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 5_000)
      throw new Error('timed out')

    await Bun.sleep(10)
  }
}

// What `/ws/:room` hands a handler for a request to `/ws/%00`.
const hostile = decodeURIComponent('%00hall%00')

describe('a room named by a visitor', () => {
  it('refuses a name past 256 characters in join, members, publish, state and update, and takes one of 256', () => {
    const live = rooms<string, string, number>({ state: () => 0 })
    const [ada] = [connection()]
    const long = 'r'.repeat(257)

    expect(() => live.join(ada, long, 'ada')).toThrow('a room name has at most 256 characters')
    expect(() => live.members(long)).toThrow('at most 256')
    expect(() => live.publish(long, 'hi')).toThrow('at most 256')
    expect(() => live.state(long)).toThrow('at most 256')
    expect(() => live.update(long, state => state)).toThrow('at most 256')
    live.join(ada, 'r'.repeat(256), 'ada')
    expect(live.members('r'.repeat(256))).toEqual(['ada'])
    expect(live.roomsOf(ada)).toEqual(['r'.repeat(256)])
  })

  it('keeps a name holding NUL apart in memory', () => {
    const live = rooms<string, string>({ store: memoryRooms() })
    const [ada, bob] = [connection(), connection()]

    live.join(ada, hostile, 'ada')
    live.join(bob, 'hall', 'bob')
    expect(live.members(hostile)).toEqual(['ada'])
    expect(live.members('hall')).toEqual(['bob'])
    live.publish(hostile, 'hi')
    expect(ada.received).toEqual(['hi'])
    expect(bob.received).toEqual([])
  })

  it('shares a name holding NUL between sqlite stores', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-rooms-names-'))

    dirs.push(dir)

    const path = join(dir, 'rooms.sqlite')
    const [one, two] = [rooms<string, string>({ store: sqliteRooms(path, { poll: '5ms' }) }), rooms<string, string>({ store: sqliteRooms(path, { poll: '5ms' }) })]
    const [ada, bob] = [connection(), connection()]

    one.join(ada, hostile, 'ada')
    two.join(bob, hostile, 'bob')
    two.members(hostile)
    await until(() => two.members(hostile).length === 2)
    expect(two.members(hostile)).toEqual(['ada', 'bob'])
    one.publish(hostile, 'hi')
    await until(() => bob.received.length === 1)
    expect(bob.received).toEqual(['hi'])
  })
})

// A handle whose queries are seen, and refused when they read a room named in `refused`.
function watching(sql: SQL, refused: string[] = []): { handle: PgHandle, lengths: number[] } {
  const lengths: number[] = []
  const db = new Proxy(sql, { get(target, property) {
    if (property !== 'unsafe') {
      const value: unknown = Reflect.get(target, property)

      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) as unknown : value
    }

    return async (text: string, values: unknown[] = []) => {
      const names = values[0]

      if (Array.isArray(names)) {
        lengths.push(names.length)

        if (names.some(name => refused.includes(name as string)))
          return Promise.reject(Object.assign(new Error('refused'), { errno: '22021' }))
      }

      return target.unsafe(text, values as never) as unknown
    }
  } })
  const inner = pgHandle(sql)

  return { handle: { db: async () => {
    await inner.db()

    return db
  } }, lengths }
}

async function logging(work: () => Promise<void>): Promise<string[]> {
  const sink = logSink()
  const lines: string[] = []

  setLogSink((level, message) => void lines.push(`${level}: ${message}`))

  try {
    await work()
  }
  finally {
    setLogSink(sink)
  }

  return lines
}

pgDescribe('a room named by a visitor in Postgres', () => {
  pgIt('shares a name holding NUL between replicas, its members and its messages', async () => {
    await postgres()

    const [first, second] = replicas(2)
    const stores = [pgRooms(pgHandle(first!), { poll: '10ms' }), pgRooms(pgHandle(second!), { poll: '10ms' })] as const
    const one = rooms<string, string>({ store: stores[0] })
    const two = rooms<string, string>({ store: stores[1] })
    const [ada, bob] = [connection(), connection()]

    one.join(ada, hostile, 'ada')
    two.join(bob, hostile, 'bob')
    await until(() => two.members(hostile).length === 2 && one.members(hostile).length === 2)
    expect(two.members(hostile).sort()).toEqual(['ada', 'bob'])
    one.publish(hostile, 'hi')
    await until(() => bob.received.length === 1)
    expect(bob.received).toEqual(['hi'])
    await Promise.all(stores.map(async store => store.close()))
  })

  pgIt('reads the other rooms and the messages when the database refuses one room', async () => {
    await postgres()

    const [first, second] = replicas(2)
    const { handle } = watching(first!, ['bad'])
    const reader = pgRooms(handle, { poll: '10ms' })
    const writer = pgRooms(pgHandle(second!), { poll: '10ms' })
    const heard: string[] = []
    const lines = await logging(async () => {
      writer.add('good', 'w1', '"w"')
      writer.add('bad', 'w2', '"x"')
      reader.subscribe((room, text) => void heard.push(`${room}:${text}`))
      reader.members('bad')
      reader.members('good')
      await until(() => reader.members('good').length === 1)
      writer.publish('good', 'hello', {})
      await until(() => heard.includes('good:hello'))
    })

    expect(reader.members('good')).toEqual(['"w"'])
    expect(lines.some(line => line.includes('"bad" failed; it is left out'))).toBe(true)
    await reader.close()
    await writer.close()
  })

  pgIt('reads at most 1000 rooms nobody here holds, the ones asked about longest ago forgotten', async () => {
    await postgres()

    const [sql] = replicas(1)
    const { handle, lengths } = watching(sql!)
    const store = pgRooms(handle, { poll: '10ms' })

    store.add('held', 'c1', '"m"')

    for (let room = 0; room < 1500; room++)
      store.members(`made-up-${room}`)

    // Five polls of the 10 ms interval, enough to see the cap held across them.
    await until(() => lengths.length >= 5)
    expect(Math.max(...lengths)).toBeLessThanOrEqual(1000)
    expect(lengths.at(-1)).toBeGreaterThanOrEqual(900)
    await store.close()
  })

  it('drops and logs the writes past 1000 waiting for a database that does not answer', async () => {
    const store = pgRooms({ db: async () => new Promise<never>(() => undefined) })
    const lines = await logging(async () => {
      for (let message = 0; message < 1500; message++)
        store.publish('hall', 'hi', {})

      // The queue logs as the writes overflow it, so no more line is expected: the wait lets a second one show.
      await Bun.sleep(20)
    })

    expect(lines.filter(line => line.includes('1000 writes wait for the database'))).toHaveLength(1)
  })
})
