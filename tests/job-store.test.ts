import type { JobStore, StoredJob } from '../src/server'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { openSqlite } from '../src/runtime/sqlite.server'
import { memoryJobs, sqliteJobs } from '../src/server'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function sqlitePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kay-job-store-'))

  dirs.push(dir)

  return join(dir, 'jobs.sqlite')
}

interface Kind { name: string, open: () => Promise<JobStore> }

// The stores that share one contract: every case below runs against each.
export const kinds: Kind[] = [
  { name: 'memory', open: async () => memoryJobs() },
  { name: 'sqlite', open: async () => sqliteJobs(await sqlitePath()) },
]

let ids = 0

function job(overrides: Partial<StoredJob> = {}): StoredJob {
  return { id: `job-${++ids}`, queue: 'q', payload: '[]', attempts: 0, runAt: 0, ...overrides }
}

const REQUIRED = <T>(value: T | undefined): T => value as T

describe.each(kinds)('job store contract, $name', ({ open }) => {
  it('hands a due job to one claim only, and again once its hold ran out', async () => {
    const store = await open()
    const added = job()

    await store.add(added)

    const [first, second] = await Promise.all([store.claim('q', 100, 200), store.claim('q', 100, 200)])

    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect(await store.claim('q', 150, 250)).toBeUndefined()
    expect((await store.claim('q', 200, 300))?.attempts).toBe(2)
  })

  describe('key', () => {
    it('refuses a second job with the key while the first waits or runs, resolving with the first\'s id', async () => {
      const store = await open()
      const first = job({ key: 'anilist', payload: 'first' })

      expect(await store.add(first)).toBeUndefined()
      expect(await store.add(job({ key: 'anilist', payload: 'second' }))).toBe(first.id)

      const claimed = REQUIRED(await store.claim('q', 10, 100))

      expect(claimed.payload).toBe('first')
      expect(await store.add(job({ key: 'anilist' }))).toBe(first.id)
      await store.complete(first.id)
      expect(await store.claim('q', 10, 100)).toBeUndefined()
    })

    it('takes the key again once its job completed or failed', async () => {
      const store = await open()
      const first = job({ key: 'k' })

      await store.add(first)
      await store.complete(first.id)
      expect(await store.add(job({ key: 'k' }))).toBeUndefined()

      const second = REQUIRED(await store.claim('q', 10, 100))

      await store.fail(second.id, 'boom')

      const third = job({ key: 'k' })

      expect(await store.add(third)).toBeUndefined()
      expect((await store.claim('q', 10, 100))?.id).toBe(third.id)
    })

    it('keeps one job when many add with one key at once', async () => {
      const store = await open()
      const results = await Promise.all(Array.from({ length: 8 }, async () => store.add(job({ key: 'race' }))))

      expect(results.filter(id => id === undefined)).toHaveLength(1)
      expect(await store.jobs?.('q')).toHaveLength(1)
      expect(new Set(results.filter(Boolean)).size).toBe(1)
    })

    it('keeps a key apart per queue, and never matches a job without one', async () => {
      const store = await open()

      expect(await store.add(job({ key: 'k' }))).toBeUndefined()
      expect(await store.add(job({ key: 'k', queue: 'other' }))).toBeUndefined()
      expect(await store.add(job())).toBeUndefined()
      expect(await store.add(job())).toBeUndefined()
    })
  })

  describe('state', () => {
    it('tells waiting from running from failed, by key or id', async () => {
      const store = await open()
      const added = job({ key: 'k' })

      expect(await store.state!('q', { key: 'k' }, 0)).toBeUndefined()
      await store.add(added)
      expect(await store.state!('q', { key: 'k' }, 0)).toMatchObject({ id: added.id, status: 'waiting', key: 'k' })
      await store.claim('q', 10, 100)
      expect(await store.state!('q', { id: added.id }, 50)).toMatchObject({ status: 'running', attempts: 1 })
      expect(await store.state!('q', { key: 'k' }, 100)).toMatchObject({ status: 'waiting' })
      await store.fail(added.id, 'boom')
      expect(await store.state!('q', { key: 'k' }, 0)).toMatchObject({ status: 'failed', error: 'boom' })
      expect(await store.state!('other', { key: 'k' }, 0)).toBeUndefined()
    })

    it('prefers the live job of a key to a failed one, and finds nothing once it completed', async () => {
      const store = await open()
      const failed = job({ key: 'k' })

      await store.add(failed)
      await store.claim('q', 10, 100)
      await store.fail(failed.id, 'boom')

      const live = job({ key: 'k' })

      await store.add(live)
      expect((await store.state!('q', { key: 'k' }, 0))?.id).toBe(live.id)
      await store.complete(live.id)
      expect((await store.state!('q', { key: 'k' }, 0))?.id).toBe(failed.id)
      await store.complete(failed.id)
      expect(await store.state!('q', { key: 'k' }, 0)).toBeUndefined()
    })
  })

  describe('progress', () => {
    it('is written while the hold is the job\'s, read back, kept by a failure and cleared by the next claim', async () => {
      const store = await open()
      const added = job({ key: 'k' })

      await store.add(added)
      await store.claim('q', 10, 100)
      await store.progress!(added.id, 100, '[1]')
      expect((await store.state!('q', { key: 'k' }, 50))?.progress).toBe('[1]')
      await store.retry(added.id, 10, 'again')
      expect((await store.state!('q', { key: 'k' }, 50))?.progress).toBe('[1]')
      await store.claim('q', 10, 200)
      expect((await store.state!('q', { key: 'k' }, 50))?.progress).toBeUndefined()
      await store.progress!(added.id, 200, '[2]')
      await store.fail(added.id, 'boom')
      expect((await store.failed('q'))[0]?.progress).toBe('[2]')
    })

    it('drops a write after completion, after the hold went to another claim, or for a hold that is not the job\'s', async () => {
      const store = await open()
      const added = job({ key: 'k' })

      await store.add(added)
      await store.claim('q', 10, 100)
      await store.progress!(added.id, 999, '[stale]')
      expect((await store.state!('q', { key: 'k' }, 50))?.progress).toBeUndefined()
      await store.claim('q', 100, 300)
      await store.progress!(added.id, 100, '[late]')
      expect((await store.state!('q', { key: 'k' }, 150))?.progress).toBeUndefined()
      await store.complete(added.id)
      await store.progress!(added.id, 300, '[after]')
      expect(await store.state!('q', { key: 'k' }, 150)).toBeUndefined()
    })
  })

  describe('release', () => {
    it('gives the attempt back and makes the job due at runAt, only for the hold it was claimed with', async () => {
      const store = await open()
      const added = job()

      await store.add(added)
      await store.claim('q', 10, 100)
      await store.release!(added.id, 999, 500)
      expect(await store.claim('q', 50, 300)).toBeUndefined()
      await store.release!(added.id, 100, 500)
      expect(await store.claim('q', 499, 600)).toBeUndefined()
      expect(await store.nextRunAt('q')).toBe(500)

      const again = REQUIRED(await store.claim('q', 500, 600))

      expect(again.attempts).toBe(1)
    })

    it('keeps the due time of a release without runAt', async () => {
      const store = await open()
      const added = job({ runAt: 5 })

      await store.add(added)
      await store.claim('q', 10, 100)
      await store.release!(added.id, 100)
      expect((await store.claim('q', 10, 100))?.attempts).toBe(1)
    })
  })
})

describe('a sqlite file made before keys and progress', () => {
  it('gains the columns and the key index, keeping its jobs', async () => {
    const path = await sqlitePath()
    const old = openSqlite(path)

    old.run('CREATE TABLE kay_jobs (id TEXT PRIMARY KEY, queue TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL, run_at INTEGER NOT NULL, held_until INTEGER, failed INTEGER NOT NULL DEFAULT 0, error TEXT)')
    old.run('INSERT INTO kay_jobs (id, queue, payload, attempts, run_at) VALUES (\'old\', \'q\', \'[]\', 0, 0)')
    old.close()

    const store = sqliteJobs(path)

    expect(await store.add(job({ key: 'k' }))).toBeUndefined()
    expect(await store.add(job({ key: 'k' }))).toBeDefined()
    expect((await store.jobs!('q')).map(listed => listed.id)).toContain('old')
    expect((await store.claim('q', 10, 100))?.id).toBe('old')
  })

  it('opens twice without error', async () => {
    const path = await sqlitePath()

    await sqliteJobs(path).add(job())
    expect(await sqliteJobs(path).add(job({ key: 'k' }))).toBeUndefined()
  })
})
