import type { LiveStore } from '../src/runtime/live-value'
import { afterEach, expect } from 'bun:test'
import { live, liveSlot, liveStoreReady, setLiveStore } from '../src/runtime/live-value'
import { setupStore } from '../src/server/app-store'
import { createDataTables, dataTables, pgData, pgHandle } from '../src/server/pg-data'
import { pgLive } from '../src/server/pg-live'
import { cleanUpAfterFile, pgDescribe, pgIt, postgres, replicas } from './job-stores'

cleanUpAfterFile()

const declare = live as unknown as (initial: number, id: string, name: string) => { (): number, set: (next: number) => void }

async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 4000): Promise<void> {
  const until = Date.now() + ms

  while (Date.now() < until) {
    if (await check())
      return

    await Bun.sleep(20)
  }

  throw new Error(`timed out waiting for ${what}`)
}

// Every table dropped first, so each case starts on an empty database.
async function fresh() {
  const { sql } = await postgres()

  // One table per statement, as one DROP of them all holds locks on the first while it waits for the next, which a poller still reading two of them deadlocks with.
  for (const table of dataTables)
    await sql.unsafe(`DROP TABLE IF EXISTS ${table}`)

  return sql
}

// Two stores on separate connections, as two replicas have.
function twoReplicas(): [LiveStore, LiveStore] {
  const [first, second] = replicas(2)

  return [pgLive(pgHandle(first!)), pgLive(pgHandle(second!))]
}

type Heard = [id: string, key: string, text: string | undefined]

function listen(store: LiveStore): Heard[] {
  const heard: Heard[] = []

  store.subscribe((id, key, text) => heard.push([id, key, text]))

  return heard
}

afterEach(() => {
  setupStore(undefined)
  setLiveStore(undefined)
})

pgDescribe('pgData live values', () => {
  pgIt('is a kind of pgData, filling every kind of the app store', async () => {
    const data = pgData(await fresh())

    expect(Object.keys(data).sort()).toEqual(['cache', 'jobs', 'live', 'rates', 'rooms', 'sessions', 'vitals'])
  })

  pgIt('reaches the other replica, a set and a delete, and never the replica that made them', async () => {
    await fresh()

    const [first, second] = twoReplicas()

    await first.entries()
    await second.entries()

    const onFirst = listen(first)
    const onSecond = listen(second)

    await first.set('app:room', 'a', '[1]')
    await first.set('app:room', 'a', '[2]')
    await waitFor(() => onSecond.at(-1)?.[2] === '[2]', 'the second replica to hear the sets')
    expect(await second.entries()).toEqual([['app:room', 'a', '[2]']])

    await second.delete('app:room', 'a')
    await waitFor(() => onFirst.length >= 1, 'the first replica to hear the delete')
    expect(onFirst).toEqual([['app:room', 'a', undefined]])
    expect(await first.entries()).toEqual([])
    const count = onSecond.length

    await Bun.sleep(700)
    expect(onSecond).toHaveLength(count)
    expect(onFirst).toHaveLength(1)
    first.stop?.()
    second.stop?.()
  })

  pgIt('is heard in the order the sets were made when their sequence numbers gain a digit', async () => {
    const sql = await fresh()
    const [first, second] = twoReplicas()

    await first.entries()
    await second.entries()

    const onSecond = listen(second)

    await sql.unsafe(`SELECT setval('kay_live_events_seq_seq', greatest(89, (SELECT coalesce(max(seq), 0) FROM kay_live_events)))`)

    const keys = Array.from({ length: 30 }, (_, at) => `k${at}`)

    for (const key of keys)
      await first.set('app:room', key, '[1]')

    await waitFor(() => onSecond.length >= keys.length, 'the second replica to hear the sets')
    expect(onSecond.map(([, key]) => key)).toEqual(keys)
    first.stop?.()
    second.stop?.()
  })

  pgIt('hands a restarted replica what is held, and a set in between is heard once', async () => {
    await fresh()

    const [before] = twoReplicas()

    await before.entries()
    await before.set('app:count', '', '[4]')
    await before.set('app:room', 'b', '[{"users":2}]')
    before.stop?.()

    const [after, other] = twoReplicas()

    expect((await after.entries()).sort()).toEqual([['app:count', '', '[4]'], ['app:room', 'b', '[{"users":2}]']])

    const heard = listen(after)

    await other.entries()
    await other.set('app:count', '', '[5]')
    await waitFor(() => heard.length >= 1, 'the restarted replica to hear the set')
    await Bun.sleep(700)
    expect(heard).toEqual([['app:count', '', '[5]']])
    after.stop?.()
    other.stop?.()
  })

  pgIt('creates its tables when the database has the others but not its own', async () => {
    const sql = await fresh()

    await createDataTables(sql)
    await sql.unsafe('DROP TABLE kay_live, kay_live_events')

    const [store] = twoReplicas()

    expect(await store.entries()).toEqual([])
    await store.set('app:count', '', '[1]')
    expect(await sql.unsafe('SELECT id, key, value FROM kay_live')).toEqual([{ id: 'app:count', key: '', value: '[1]' }])
    store.stop?.()
  })

  pgIt('keeps hostile ids and keys as data: quotes, SQL, a NUL, unicode and long ones', async () => {
    const sql = await fresh()
    const [first, second] = twoReplicas()
    const hostile: [string, string][] = [['app:x\'; DROP TABLE kay_live; --', '"; DELETE FROM kay_live; --'], ['app:nul', 'a\u0000b'], ['app:slash', 'a\\0b\\'], ['app:emoji', '\u{1F426}é'], ['app:long', 'k'.repeat(5000)], ['app:empty', '']]

    await first.entries()
    await second.entries()

    const heard = listen(second)

    for (const [id, key] of hostile)
      await first.set(id, key, `["${id.length}"]`)

    await waitFor(() => heard.length >= hostile.length, 'every hostile key to be heard')
    expect(heard.map(([id, key]) => [id, key]).sort()).toEqual([...hostile].sort())
    expect((await second.entries()).map(([id, key]) => [id, key]).sort()).toEqual([...hostile].sort())
    expect((await sql.unsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM kay_live'))[0]).toEqual({ n: hostile.length })

    await first.delete('app:nul', 'a\u0000b')
    await waitFor(() => heard.some(([id, , text]) => id === 'app:nul' && text === undefined), 'the NUL key to be deleted')
    expect((await second.entries()).some(([id]) => id === 'app:nul')).toBe(false)
    first.stop?.()
    second.stop?.()
  })

  pgIt('applies writes in the order they were made, and an entries read waits for them', async () => {
    await fresh()

    const [store] = twoReplicas()

    await store.entries()
    void store.set('app:order', '', '[1]')
    void store.set('app:order', '', '[2]')
    void store.delete('app:order', 'gone')
    void store.set('app:order', 'k', '[3]')
    expect((await store.entries()).sort()).toEqual([['app:order', '', '[2]'], ['app:order', 'k', '[3]']])
    store.stop?.()
  })

  pgIt('stop ends the polling and a later subscribe follows again', async () => {
    await fresh()

    const [first, second] = twoReplicas()

    await first.entries()
    await second.entries()

    const heard = listen(second)

    second.stop?.()
    await first.set('app:stop', '', '[1]')
    await Bun.sleep(900)
    expect(heard).toEqual([])
    first.stop?.()
  })

  pgIt('is read before the server serves, written behind, and heard by a live() value', async () => {
    const sql = await fresh()
    const [other] = twoReplicas()
    const count = declare(0, 'test:pg-live-count', 'count')

    await other.entries()
    await other.set('test:pg-live-count', '', '[7]')
    setupStore(pgData(sql))
    await liveStoreReady()
    expect(count()).toBe(7)

    count.set(8)
    await waitFor(async () => (await sql.unsafe<{ value: string }[]>('SELECT value FROM kay_live WHERE id = \'test:pg-live-count\''))[0]?.value === '[8]', 'the written row')

    const seen: number[] = []

    liveSlot('test:pg-live-count')!.listeners.set('', new Set([() => seen.push(count())]))
    await other.set('test:pg-live-count', '', '[9]')
    await waitFor(() => seen.length > 0, 'the value set elsewhere')
    expect(count()).toBe(9)
    other.stop?.()
  })

  pgIt('does not replace a value this replica is still writing with the older row another replica set', async () => {
    const sql = await fresh()
    const [mine, theirs] = twoReplicas()
    const [locker] = replicas(1)

    await mine.entries()
    await theirs.entries()

    const heard = listen(mine)

    await theirs.set('app:race', '', '[1]')
    await waitFor(() => heard.length === 1, 'the first value')

    let release: () => void = () => undefined
    let locked: () => void = () => undefined
    const gotLock = new Promise<void>((resolve) => {
      locked = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // Holds the row, so this replica's write waits while the other replica's event is already there.
    const holding = locker!.begin(async (tx) => {
      await tx.unsafe('SELECT 1 FROM kay_live WHERE id = \'app:race\' FOR UPDATE')
      locked()
      await held
    })

    await gotLock

    const writing = mine.set('app:race', '', '[2]')

    await Bun.sleep(100)
    await sql.unsafe('INSERT INTO kay_live_events (origin, id, key, at) VALUES (\'another\', \'app:race\', \'\', 0)')
    await Bun.sleep(1200)
    release()
    await holding
    await writing
    await Bun.sleep(1200)
    expect(heard.slice(1).every(([, , text]) => text !== '[1]')).toBe(true)
    expect((await sql.unsafe<{ value: string }[]>('SELECT value FROM kay_live WHERE id = \'app:race\''))[0]?.value).toBe('[2]')
    mine.stop?.()
    theirs.stop?.()
  })

  pgIt('a value set while the store is still being read is not overwritten by an older row', async () => {
    const sql = await fresh()
    const [other] = twoReplicas()
    const racing = declare(0, 'test:pg-live-racing', 'racing')

    await other.entries()
    await other.set('test:pg-live-racing', '', '[1]')

    setupStore(pgData(sql))
    racing.set(2)
    await liveStoreReady()
    expect(racing()).toBe(2)
    await waitFor(async () => (await sql.unsafe<{ value: string }[]>('SELECT value FROM kay_live WHERE id = \'test:pg-live-racing\''))[0]?.value === '[2]', 'the local write to land')
    other.stop?.()
  })
})
