import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { background, memoryJobs, queue, schedule, shutdown, sqliteJobs } from '../src/server'
import { drainQueues } from '../src/server/queue'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function jobsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kay-jobs-'))

  dirs.push(dir)

  return join(dir, 'data', 'jobs.sqlite')
}

async function until(condition: () => boolean, timeout = 5000): Promise<void> {
  for (const start = Date.now(); !condition(); await Bun.sleep(20)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

// Bun.cron stood in for, so a test fires the job itself instead of waiting for the minute.
function fakeCron() {
  const fired: { handler: () => unknown, stopped: boolean }[] = []
  const { parse } = Bun.cron
  const cron = spyOn(Bun, 'cron').mockImplementation(((_: string, handler: () => unknown) => {
    const entry = { handler, stopped: false }

    fired.push(entry)

    return { stop: () => void (entry.stopped = true) }
  }) as unknown as typeof Bun.cron)

  Object.assign(Bun.cron, { parse })

  return { fired, restore: () => cron.mockRestore() }
}

describe('schedule', () => {
  it('starts with the server, once, and stops with it, waiting for the run in progress', async () => {
    const cron = fakeCron()
    const runs: string[] = []
    const app = new Elysia().use(schedule('@hourly', async () => {
      runs.push('start')
      await Bun.sleep(20)
      runs.push('end')
    }))

    try {
      expect(cron.fired).toHaveLength(0)
      app.listen(0)
      expect(cron.fired).toHaveLength(1)

      const run = cron.fired[0]!.handler()

      await shutdown(app)
      expect(runs).toEqual(['start', 'end'])
      expect(cron.fired[0]!.stopped).toBe(true)
      await run
    }
    finally {
      cron.restore()
    }
  })

  it('logs a run that throws and keeps the schedule', async () => {
    const cron = fakeCron()
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const app = new Elysia().use(schedule('*/5 * * * *', () => {
      throw new Error('feed down')
    })).listen(0)

    try {
      await cron.fired[0]!.handler()
      expect(logged.mock.calls.flat().join(' ')).toContain('kay: the job scheduled */5 * * * * failed')
      expect(cron.fired[0]!.stopped).toBe(false)
    }
    finally {
      await shutdown(app)
      logged.mockRestore()
      cron.restore()
    }
  })

  it('refuses a computed schedule it cannot read, or one that never comes, at boot', () => {
    const computed = (cron: string) => cron

    expect(() => schedule(computed('every hour'), () => undefined)).toThrow('Invalid cron expression')
    expect(() => schedule(computed('0 0 30 2 *'), () => undefined)).toThrow('the schedule 0 0 30 2 * never comes')
  })

  // `bun run check` fails on an `@ts-expect-error` with no error under it, so the type check is what these assert.
  it('types a literal schedule, refusing a nickname, a field count or a day its month never has', () => {
    const typed = (_build: () => unknown) => true

    expect(typed(() => [schedule('@hourly', () => undefined), schedule('30  2 * * MON', () => undefined), schedule('0 0 31 */2 *', () => undefined), schedule('0 0 30 2 MON', () => undefined), schedule('0 0 30 jan *', () => undefined), schedule('@DAILY', () => undefined), schedule('0\t0\t*\t*\t*', () => undefined)])).toBe(true)
    // @ts-expect-error -- no such nickname
    expect(typed(() => schedule('@minutely', () => undefined))).toBe(true)
    // @ts-expect-error -- six fields
    expect(typed(() => schedule('* * * * * *', () => undefined))).toBe(true)
    // @ts-expect-error -- February has no 30th
    expect(typed(() => schedule('0 0 30 feb *', () => undefined))).toBe(true)
    // @ts-expect-error -- April has no 31st
    expect(typed(() => schedule('0 0 31 04 *', () => undefined))).toBe(true)
  })

  it('runs a locked schedule once across processes sharing its store, each minute it comes', async () => {
    const cron = fakeCron()
    const path = await jobsPath()
    const runs: string[] = []
    // Two processes, each with its own connection to the store.
    const first = new Elysia().use(schedule('@hourly', () => runs.push('first'), { lock: 'report', store: sqliteJobs(path) })).listen(0)
    const second = new Elysia().use(schedule('@hourly', () => runs.push('second'), { lock: 'report', store: sqliteJobs(path) })).listen(0)

    try {
      await Promise.all(cron.fired.map(async entry => entry.handler()))
      expect(runs).toEqual(['first'])

      setSystemTime(Date.now() + 3_600_000)
      await Promise.all(cron.fired.toReversed().map(async entry => entry.handler()))
      expect(runs).toEqual(['first', 'second'])
    }
    finally {
      setSystemTime()
      cron.restore()
      await shutdown(first)
      await shutdown(second)
    }
  })

  it('keeps two schedules apart', () => {
    const cron = fakeCron()

    try {
      const app = new Elysia().use(schedule('@hourly', () => undefined)).use(schedule('@daily', () => undefined)).listen(0)

      expect(cron.fired).toHaveLength(2)
      void shutdown(app)
    }
    finally {
      cron.restore()
    }
  })
})

describe('background', () => {
  it('runs from start to stop, its signal aborting on stop and the server waiting for it', async () => {
    const steps: string[] = []
    const app = new Elysia().use(background(async (signal) => {
      steps.push('started')
      await new Promise(resolve => signal.addEventListener('abort', resolve))
      await Bun.sleep(10)
      steps.push('cleaned up')
    }))

    expect(steps).toEqual([])
    app.listen(0)
    expect(steps).toEqual(['started'])
    await shutdown(app)
    expect(steps).toEqual(['started', 'cleaned up'])
  })
})

describe('queue', () => {
  it('runs a job enqueued by a process that stopped since, once, in the server', async () => {
    const path = await jobsPath()
    const child = Bun.spawn([process.execPath, '-e', `import { queue, sqliteJobs } from ${JSON.stringify(resolve('src/server/index.ts'))}\nawait queue('mail', () => {}, { store: sqliteJobs(${JSON.stringify(path)}) }).enqueue({ to: 'ada@example.com', at: new Date(0) })\n`], { stderr: 'inherit' })

    expect(await child.exited).toBe(0)

    const sent: { to: string, at: Date }[] = []
    const mail = queue('mail', (job: { to: string, at: Date }) => void sent.push(job), { store: sqliteJobs(path) })
    const app = new Elysia().use(mail).listen(0)

    try {
      await until(() => sent.length > 0)
      await Bun.sleep(100)
      expect(sent).toEqual([{ to: 'ada@example.com', at: new Date(0) }])
    }
    finally {
      await shutdown(app)
    }
  })

  it('wakes its worker for a job enqueued in the same process, and waits for the run in progress on stop', async () => {
    const steps: string[] = []
    const work = queue('work', async (step: string) => {
      steps.push(`${step} started`)
      await Bun.sleep(30)
      steps.push(`${step} done`)
    }, { store: memoryJobs() })
    const app = new Elysia().use(work).listen(0)

    await Bun.sleep(20)
    await work.enqueue('a')
    await until(() => steps.length > 0, 200)
    await shutdown(app)
    expect(steps).toEqual(['a started', 'a done'])
  })

  it('runs each job in one of the processes sharing the store', async () => {
    const path = await jobsPath()
    const ran: number[] = []
    const handler = async (n: number) => {
      ran.push(n)
      await Bun.sleep(1)
    }
    const first = queue('shared', handler, { store: sqliteJobs(path), concurrency: 2 })
    const second = queue('shared', handler, { store: sqliteJobs(path), concurrency: 2 })

    for (let n = 0; n < 30; n++)
      await first.enqueue(n)

    const apps = [new Elysia().use(first).listen(0), new Elysia().use(second).listen(0)]

    try {
      await until(() => ran.length >= 30)
      await Bun.sleep(100)
      expect(ran.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, n) => n))
    }
    finally {
      await Promise.all(apps.map(async app => shutdown(app)))
    }
  })

  it('retries a failing job after a doubling wait, then keeps it as failed and hands it to onFailed', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const tries: number[] = []
    const gaveUp: unknown[] = []
    const flaky = queue('flaky', (n: number) => {
      tries.push(n)

      throw new Error('mail server down')
    }, { store: memoryJobs(), attempts: 3, backoff: '10s', onFailed: (n, error) => void gaveUp.push([n, (error as Error).message]) })

    try {
      await flaky.enqueue(1)
      expect(await flaky.drain()).toBe(1)
      // Not before its wait: 10 seconds, then 20.
      setSystemTime(Date.now() + 9_000)
      expect(await flaky.drain()).toBe(0)
      setSystemTime(Date.now() + 2_000)
      expect(await flaky.drain()).toBe(1)
      setSystemTime(Date.now() + 15_000)
      expect(await flaky.drain()).toBe(0)
      setSystemTime(Date.now() + 6_000)
      expect(await flaky.drain()).toBe(1)

      expect(tries).toEqual([1, 1, 1])
      expect(gaveUp).toEqual([[1, 'mail server down']])
      expect(await flaky.failed()).toEqual([{ id: expect.any(String), payload: 1, attempts: 3, error: 'mail server down' }])
      expect(logged).toHaveBeenCalled()

      setSystemTime(Date.now() + 3_600_000)
      expect(await flaky.drain()).toBe(0)
    }
    finally {
      setSystemTime()
      logged.mockRestore()
    }
  })

  it('runs again a job whose process died running it, once it counts as lost', async () => {
    const store = memoryJobs()
    const runs: string[] = []
    const lost = queue('lost', (name: string) => void runs.push(name), { store, lostAfter: '5m' })

    try {
      await lost.enqueue('report')
      // A process takes it, then dies before marking how it went.
      expect(await store.claim('lost', Date.now(), Date.now() + 300_000)).toBeDefined()
      expect(await lost.drain()).toBe(0)
      setSystemTime(Date.now() + 301_000)
      expect(await lost.drain()).toBe(1)
      expect(runs).toEqual(['report'])
    }
    finally {
      setSystemTime()
    }
  })

  it('runs later a job enqueued with a delay, and in memory under bun test when no store is named', async () => {
    const runs: string[] = []
    const later = queue('later', (name: string) => void runs.push(name))

    try {
      await later.enqueue('soon', { delay: '1m' })
      await later.enqueue('now')
      // What kay/test's runJobs does: every queue, until none has a job due.
      expect(await drainQueues()).toBe(1)
      setSystemTime(Date.now() + 61_000)
      expect(await drainQueues()).toBe(1)
      expect(runs).toEqual(['now', 'soon'])
      expect(await Bun.file('data/jobs.sqlite').exists()).toBe(false)
    }
    finally {
      setSystemTime()
    }
  })

  it('refuses attempts or a concurrency that is no whole number of at least 1', () => {
    expect(() => queue('x', () => undefined, { attempts: 0 })).toThrow('attempts is 0')
    expect(() => queue('x', () => undefined, { concurrency: 1.5 })).toThrow('concurrency is 1.5')
    expect(() => queue('x', () => undefined, { backoff: '0s' })).toThrow('backoff')
  })
})
