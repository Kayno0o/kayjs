import type { JobContext, JobStore, Queue, QueueOptions } from '../src/server'
import { afterEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { parse } from 'devalue'
import { Elysia } from 'elysia'
import { queue as makeQueue, memoryJobs, retryLater, shutdown } from '../src/server'
import { forgetQueue } from '../src/server/queue'
import { cleanUpAfterFile, kinds } from './job-stores'

cleanUpAfterFile()

let names = 0
const writeListeners = new Set<() => void>()

// A store telling the cases below when one of its progress writes landed.
function watched(store: JobStore): JobStore {
  return {
    ...store,
    progress: async (id, until, progress) => {
      await store.progress!(id, until, progress)

      for (const listener of writeListeners)
        listener()
    },
  }
}

async function nextWrite(): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      writeListeners.delete(done)
      resolve()
    }

    writeListeners.add(done)
  })
}

const made: { drain: () => Promise<number> }[] = []

// Every queue made here leaves what `drainQueues` runs with its test, as its store's database goes with its file.
function queue<Payload, Progress = unknown>(name: string, handler: (payload: Payload, signal: AbortSignal, job: JobContext<Progress>) => unknown, options?: QueueOptions<Payload>): Queue<Payload, Progress> {
  const created = makeQueue<Payload, Progress>(name, handler, options)

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
      expect(await jobs.job('k')).toMatchObject({ id: first, status: 'failed', error: 'boom' })

      fail = false

      const second = await jobs.enqueue(2, { key: 'k' })

      expect(second).not.toBe(first)
      expect(await jobs.drain()).toBe(1)
      expect(await jobs.job('k')).toMatchObject({ id: first, status: 'failed' })
      await jobs.remove(first)
      expect(await jobs.job('k')).toBeUndefined()
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
      expect(await jobs.job('k')).toBeUndefined()
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

  describe('retryLater', () => {
    afterEach(() => {
      setSystemTime()
    })

    it('runs the job again after its wait however many times, with attempts: 3, and never keeps it as failed', async () => {
      const logs = spyOn(console, 'log').mockImplementation(noop)
      const errors = spyOn(console, 'error').mockImplementation(noop)
      const warns = spyOn(console, 'warn').mockImplementation(noop)
      let runs = 0
      const failed: unknown[] = []
      const jobs = queue<number>(named(), () => {
        if (++runs <= 10)
          throw retryLater('30s')
      }, { store: await open(), attempts: 3, onFailed: ({ error }) => void failed.push(error) })
      const id = await jobs.enqueue(1, { key: 'k' })

      for (let round = 1; round <= 10; round++) {
        expect(await jobs.drain()).toBe(1)
        expect(await jobs.job('k')).toEqual({ id, status: 'waiting', attempts: 0 })
        // Not due before its wait.
        expect(await jobs.drain()).toBe(0)
        setSystemTime(Date.now() + 31_000)
      }

      expect(await jobs.drain()).toBe(1)
      expect(runs).toBe(11)
      expect(await jobs.job('k')).toBeUndefined()
      expect(failed).toEqual([])
      expect(errors).not.toHaveBeenCalled()
      expect(warns).not.toHaveBeenCalled()
      logs.mockRestore()
      errors.mockRestore()
      warns.mockRestore()
    })

    it('leaves the attempts a real failure spent between local retries, so attempts still run out', async () => {
      const errors = spyOn(console, 'error').mockImplementation(noop)
      const warns = spyOn(console, 'warn').mockImplementation(noop)
      const logs = spyOn(console, 'log').mockImplementation(noop)
      const outcomes = [retryLater('1m'), retryLater('1m'), new Error('real 1'), retryLater('1m'), new Error('real 2'), new Error('real 3')]
      const jobs = queue<number>(named(), () => {
        throw outcomes.shift()
      }, { store: await open(), attempts: 3, backoff: '1s' })

      await jobs.enqueue(1, { key: 'k' })

      for (let round = 0; round < 6; round++) {
        await jobs.drain()
        setSystemTime(Date.now() + 61_000)
      }

      expect(await jobs.job('k')).toMatchObject({ status: 'failed', attempts: 3, error: 'real 3' })
      logs.mockRestore()
      errors.mockRestore()
      warns.mockRestore()
    })

    it('hands the job back untouched when the store cannot release, as a failed attempt with its backoff', async () => {
      const warns = spyOn(console, 'warn').mockImplementation(noop)
      const store: JobStore = { ...memoryJobs(), release: undefined }
      const jobs = queue<number>(named(), () => {
        throw retryLater('1h')
      }, { store, attempts: 3, backoff: '1m' })

      await jobs.enqueue(1, { key: 'k' })
      await jobs.drain()
      expect(await jobs.job('k')).toMatchObject({ status: 'waiting', attempts: 1 })
      expect(warns.mock.calls.flat().join('')).toContain('release')
      warns.mockRestore()
    })

    it('refuses a wait that is no positive duration', () => {
      expect(() => retryLater('0s')).toThrow('positive duration')
      expect(() => retryLater('soon' as never)).toThrow('positive duration')
    })
  })

  describe('progress', () => {
    // Waits for a write to reach the store rather than a clock: checks, then sleeps until the next write lands.
    async function seen<Progress>(jobs: Queue<number, Progress>, key: string, present: (progress: Progress | undefined) => boolean) {
      for (;;) {
        const next = nextWrite()
        const state = await jobs.job(key)

        if (present(state?.progress))
          return state

        await next
      }
    }

    it('is written by the handler and read back typed, dates and maps included, while the job runs', async () => {
      const store = watched(await open())
      const reads: unknown[] = []
      const jobs = queue<number, { processed: number, total: number, since: Date }>(named(), async (_payload, _signal, job) => {
        job.progress({ processed: 3, total: 40, since: new Date(0) })
        reads.push((await seen(jobs, 'k', progress => progress?.processed === 3))?.progress)
      }, { store })

      await jobs.enqueue(1, { key: 'k' })
      await jobs.drain()
      expect(reads).toEqual([{ processed: 3, total: 40, since: new Date(0) }])
      expect(await jobs.job('k')).toBeUndefined()
    })

    it('keeps the last value a failed job reported, and clears it for the next run of a retried job', async () => {
      const errors = spyOn(console, 'error').mockImplementation(noop)
      const warns = spyOn(console, 'warn').mockImplementation(noop)
      const starts: unknown[] = []
      const jobs = queue<number, number>(named(), async (_payload, _signal, job) => {
        starts.push((await jobs.job('k'))?.progress)
        job.progress(job.attempts * 10)
        await seen(jobs, 'k', progress => progress === job.attempts * 10)

        throw new Error('boom')
      }, { store: watched(await open()), attempts: 2, backoff: '1s' })

      await jobs.enqueue(1, { key: 'k' })
      await jobs.drain()
      expect(await jobs.job('k')).toMatchObject({ status: 'waiting', progress: 10 })
      setSystemTime(Date.now() + 2000)
      await jobs.drain()
      expect(starts).toEqual([undefined, undefined])
      expect(await jobs.job('k')).toMatchObject({ status: 'failed', progress: 20, attempts: 2 })
      errors.mockRestore()
      warns.mockRestore()
      setSystemTime()
    })

    it('writes the latest of many reports, not each one', async () => {
      const store = watched(await open())
      const written: string[] = []
      const counted: JobStore = {
        ...store,
        progress: async (id, until, progress) => {
          written.push(progress)
          await store.progress!(id, until, progress)
        },
      }
      const last = queue<number, number>(named(), async (_payload, _signal, job) => {
        for (let step = 1; step <= 500; step++)
          job.progress(step)

        await seen(last, 'k', progress => progress === 500)
      }, { store: counted })

      await last.enqueue(1, { key: 'k' })
      await last.drain()
      expect(written.length).toBeLessThan(10)
      expect(parse(written.at(-1)!)).toBe(500)
    })

    it('drops a report made after the run ended, and never throws it at the handler', async () => {
      const store = watched(await open())
      let late: (() => void) | undefined
      const jobs = queue<number, number>(named(), async (_payload, _signal, job) => {
        late = () => job.progress(99)
        job.progress(1)
      }, { store, attempts: 1 })

      await jobs.enqueue(1, { key: 'k' })
      await jobs.drain()
      late!()
      await Bun.sleep(20)
      expect(await jobs.job('k')).toBeUndefined()

      const next = await jobs.enqueue(2, { key: 'k' })

      expect(await jobs.job({ id: next })).toEqual({ id: next, status: 'waiting', attempts: 0 })
      late!()
      await Bun.sleep(20)
      expect(await jobs.job({ id: next })).toEqual({ id: next, status: 'waiting', attempts: 0 })
      await jobs.drain()
    })

    it('logs a store that fails to write it and goes on running the handler', async () => {
      const warns = spyOn(console, 'warn').mockImplementation(noop)
      const store: JobStore = { ...(watched(await open())), progress: async () => Promise.reject(new Error('locked')) }
      let finished = false
      const jobs = queue<number, number>(named(), async (_payload, _signal, job) => {
        job.progress(1)
        await Bun.sleep(20)
        finished = true
      }, { store })

      await jobs.enqueue(1)
      await jobs.drain()
      expect(finished).toBe(true)
      expect(warns.mock.calls.flat().join('')).toContain('locked')
      warns.mockRestore()
    })

    it('logs a report devalue cannot serialize instead of throwing it at the handler, and keeps the last good one', async () => {
      const warns = spyOn(console, 'warn').mockImplementation(noop)
      const jobs = queue<number, unknown>(named(), async (_payload, _signal, job) => {
        job.progress(1)
        await seen(jobs, 'k', progress => progress === 1)
        job.progress(() => 2)
      }, { store: watched(await open()), attempts: 1 })

      await jobs.enqueue(1, { key: 'k' })
      expect(await jobs.drain()).toBe(1)
      expect(warns.mock.calls.flat().join('')).toContain('serialize')
      warns.mockRestore()
    })

    it('says once that a store without progress keeps none, and runs the job', async () => {
      const warns = spyOn(console, 'warn').mockImplementation(noop)
      const store: JobStore = { ...(watched(await open())), progress: undefined }
      const jobs = queue<number, number>(named(), (_payload, _signal, job) => {
        job.progress(1)
        job.progress(2)
      }, { store })

      await jobs.enqueue(1)
      await jobs.enqueue(2)
      expect(await jobs.drain()).toBe(2)
      expect(warns.mock.calls.filter(call => String(call[0]).includes('progress'))).toHaveLength(1)
      warns.mockRestore()
    })

    it('hands the handler its job id and the run it is on', async () => {
      const got: unknown[] = []
      const jobs = queue<number>(named(), (_payload, _signal, job) => void got.push({ id: job.id, attempts: job.attempts }), { store: watched(await open()) })
      const id = await jobs.enqueue(1)

      await jobs.drain()
      expect(got).toEqual([{ id, attempts: 1 }])
    })
  })

  describe('job', () => {
    it('tells waiting from running, by key or by id, and nothing for a job that completed or never was', async () => {
      const store = await open()
      const seen: unknown[] = []
      const jobs = queue<number>(named(), async () => {
        seen.push(await jobs.job('k'))
      }, { store })

      expect(await jobs.job('k')).toBeUndefined()

      const id = await jobs.enqueue(1, { key: 'k' })

      expect(await jobs.job('k')).toEqual({ id, status: 'waiting', attempts: 0 })
      expect(await jobs.job({ id })).toMatchObject({ id, status: 'waiting' })
      await jobs.drain()
      expect(seen).toEqual([{ id, status: 'running', attempts: 1 }])
      expect(await jobs.job('k')).toBeUndefined()
      expect(await jobs.job({ id })).toBeUndefined()
    })

    it('shows a job waiting for its retry with the error of its last run', async () => {
      const warns = spyOn(console, 'warn').mockImplementation(noop)
      const store = await open()
      const jobs = queue<number>(named(), () => {
        throw new Error('nope')
      }, { store, attempts: 3, backoff: '1h' })
      const id = await jobs.enqueue(1, { key: 'k' })

      await jobs.drain()
      expect(await jobs.job('k')).toEqual({ id, status: 'waiting', attempts: 1, error: 'nope' })
      warns.mockRestore()
    })
  })
})

describe('a queue on a store without keys', () => {
  it('throws from enqueue with a key and from state, rather than leave a key unkept', async () => {
    const store: JobStore = { ...memoryJobs(), state: undefined }
    const jobs = queue<number>(named(), noop, { store })

    await expect(jobs.enqueue(1, { key: 'k' })).rejects.toThrow('state')
    await expect(jobs.job('k')).rejects.toThrow('state')
    expect(await jobs.enqueue(1)).toBeString()
    await jobs.drain()
  })
})

describe('a running queue', () => {
  it('wakes its worker for the job it handed back for later, and runs it once the wait is over', async () => {
    const logs = spyOn(console, 'log').mockImplementation(noop)
    const runs: number[] = []
    const jobs = queue<number>(named(), () => {
      runs.push(Date.now())

      if (runs.length === 1)
        throw retryLater('1s')
    }, { store: memoryJobs(), attempts: 1, idlePoll: '30s' })
    const app = new Elysia().use(jobs).listen(0)

    try {
      await jobs.enqueue(1)

      for (const start = Date.now(); runs.length < 2 && Date.now() - start < 5000;)
        await Bun.sleep(20)

      expect(runs).toHaveLength(2)
      expect(runs[1]! - runs[0]!).toBeGreaterThanOrEqual(950)
      expect(runs[1]! - runs[0]!).toBeLessThan(3000)
    }
    finally {
      await shutdown(app)
      logs.mockRestore()
    }
  })
})
