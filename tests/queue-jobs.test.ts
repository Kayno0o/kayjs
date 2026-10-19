import type { JobStore, Queue, QueueOptions } from '../src/server'
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { queue as makeQueue, memoryJobs } from '../src/server'
import { forgetQueue } from '../src/server/queue'
import { cleanUpAfterFile, kinds } from './job-stores'

cleanUpAfterFile()

let names = 0
const made: { drain: () => Promise<number> }[] = []

// Every queue made here leaves what `drainQueues` runs with its test, as its store's database goes with its file.
function queue<Payload>(name: string, handler: (payload: Payload, signal: AbortSignal) => unknown, options?: QueueOptions<Payload>): Queue<Payload> {
  const created = makeQueue<Payload>(name, handler, options)

  made.push(created)

  return created
}

afterEach(() => {
  for (const created of made.splice(0))
    forgetQueue(created)
})
const noop = () => undefined

// A queue of its own name, so cases sharing a Postgres never meet each other's jobs.
function named() {
  return `jobs-${++names}`
}

describe.each(kinds)('a queue on a $name store', ({ open }) => {
  describe('enqueue with a key', () => {
    it('keeps one job for two enqueues with one key, both resolving with its id, and runs it once', async () => {
      const store = await open()
      const ran: string[] = []
      const jobs = queue<{ from: string }>(named(), ({ from }) => void ran.push(from), { store })
      const first = await jobs.enqueue({ from: 'first' }, { key: 'anilist' })
      const second = await jobs.enqueue({ from: 'second' }, { key: 'anilist' })

      expect(second).toBe(first)
      expect(await jobs.drain()).toBe(1)
      expect(ran).toEqual(['first'])
    })

    it('accepts the key again once its job completed, and once it was kept as failed', async () => {
      const errors = spyOn(console, 'error').mockImplementation(noop)
      const store = await open()
      let fail = true
      const jobs = queue<number>(named(), () => {
        if (fail)
          throw new Error('boom')
      }, { store, attempts: 1 })
      const first = await jobs.enqueue(1, { key: 'k' })

      await jobs.drain()
      expect(await jobs.state('k')).toMatchObject({ id: first, status: 'failed', error: 'boom' })

      fail = false

      const second = await jobs.enqueue(2, { key: 'k' })

      expect(second).not.toBe(first)
      expect(await jobs.drain()).toBe(1)
      expect(await jobs.state('k')).toMatchObject({ id: first, status: 'failed' })
      await jobs.remove(first)
      expect(await jobs.state('k')).toBeUndefined()
      errors.mockRestore()
    })

    it('skips an enqueue while the job with the key runs', async () => {
      const store = await open()
      const during: string[] = []
      const jobs = queue<number>(named(), async () => {
        during.push(await jobs.enqueue(2, { key: 'k' }))
      }, { store })
      const id = await jobs.enqueue(1, { key: 'k' })

      expect(await jobs.drain()).toBe(1)
      expect(during).toEqual([id])
      expect(await jobs.state('k')).toBeUndefined()
    })

    it('never skips a job without a key, and keeps keys apart per queue', async () => {
      const store = await open()
      const a = queue<number>(named(), noop, { store })
      const b = queue<number>(named(), noop, { store })

      await a.enqueue(1)
      await a.enqueue(1)
      await a.enqueue(1, { key: 'k' })
      await b.enqueue(1, { key: 'k' })
      expect(await a.drain()).toBe(3)
      expect(await b.drain()).toBe(1)
    })

    it('keeps one job when a retry storm of enqueues races on one key', async () => {
      const store = await open()
      const jobs = queue<number>(named(), noop, { store })
      const ids = await Promise.all(Array.from(Array.from({ length: 12 }).keys(), async index => jobs.enqueue(index, { key: 'race' })))

      expect(new Set(ids).size).toBe(1)
      expect(await jobs.drain()).toBe(1)
    })

    it('refuses an empty key', async () => {
      const jobs = queue<number>(named(), noop, { store: await open() })

      await expect(jobs.enqueue(1, { key: '' })).rejects.toThrow('key')
    })
  })

  describe('state', () => {
    it('tells waiting from running, by key or by id, and nothing for a job that completed or never was', async () => {
      const store = await open()
      const seen: unknown[] = []
      const jobs = queue<number>(named(), async () => {
        seen.push(await jobs.state('k'))
      }, { store })

      expect(await jobs.state('k')).toBeUndefined()

      const id = await jobs.enqueue(1, { key: 'k' })

      expect(await jobs.state('k')).toEqual({ id, status: 'waiting', attempts: 0 })
      expect(await jobs.state({ id })).toMatchObject({ id, status: 'waiting' })
      await jobs.drain()
      expect(seen).toEqual([{ id, status: 'running', attempts: 1 }])
      expect(await jobs.state('k')).toBeUndefined()
      expect(await jobs.state({ id })).toBeUndefined()
    })

    it('shows a job waiting for its retry with the error of its last run', async () => {
      const warns = spyOn(console, 'warn').mockImplementation(noop)
      const store = await open()
      const jobs = queue<number>(named(), () => {
        throw new Error('nope')
      }, { store, attempts: 3, backoff: '1h' })
      const id = await jobs.enqueue(1, { key: 'k' })

      await jobs.drain()
      expect(await jobs.state('k')).toEqual({ id, status: 'waiting', attempts: 1, error: 'nope' })
      warns.mockRestore()
    })
  })
})

describe('a queue on a store without keys', () => {
  it('throws from enqueue with a key and from state, rather than leave a key unkept', async () => {
    const store: JobStore = { ...memoryJobs(), state: undefined }
    const jobs = queue<number>(named(), noop, { store })

    await expect(jobs.enqueue(1, { key: 'k' })).rejects.toThrow('state')
    await expect(jobs.state('k')).rejects.toThrow('state')
    expect(await jobs.enqueue(1)).toBeString()
    await jobs.drain()
  })
})
