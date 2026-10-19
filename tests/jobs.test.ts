import type { JobStore } from '../src/server'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, jest, setSystemTime, spyOn } from 'bun:test'
import { stringify } from 'devalue'
import { Elysia } from 'elysia'
import { openSqlite } from '../src/runtime/sqlite.server'
import { background, memoryJobs, queue, schedule, shutdown, sqliteJobs } from '../src/server'
import { drainQueues } from '../src/server/queue'
import { reportBackgroundError, useAppOnError } from '../src/server/report'

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
  const parse = Bun.cron.parse.bind(Bun.cron)
  const cron = spyOn(Bun, 'cron').mockImplementation(((_: string, handler: () => unknown) => {
    const entry = { handler, stopped: false }

    fired.push(entry)

    return { stop: () => void (entry.stopped = true) }
  }) as unknown as typeof Bun.cron)

  Object.assign(Bun.cron, { parse })

  return { fired, restore: () => cron.mockRestore() }
}

const scheduleOf = schedule
let copies = 0

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

  it.each([
    ['one it cannot read', 'every hour', 'Invalid cron expression'],
    ['one that never comes', '0 0 30 2 *', 'the schedule 0 0 30 2 * never comes'],
  ])('refuses a computed schedule at boot: %s', (_name, cron, message) => {
    const computed = (text: string) => text

    expect(() => schedule(computed(cron), () => undefined)).toThrow(message)
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

  it('runs a list of jobs, and a table of schedules to jobs, each on its own schedule from one plugin', async () => {
    const cron = fakeCron()
    const runs: string[] = []
    const jobs = [() => runs.push('a'), async () => {
      throw new Error('b down')
    }, () => runs.push('c')]
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const app = new Elysia().use(schedule({ '@hourly': jobs, '0 2 * * *': () => runs.push('daily'), '30s': () => runs.push('often') }, { tz: 'Europe/Paris' })).listen(0)

    try {
      expect(cron.fired).toHaveLength(4)
      await Promise.all(cron.fired.map(async entry => entry.handler()))
      expect(runs.toSorted()).toEqual(['a', 'c', 'daily'])
      expect(logged.mock.calls.flat().join(' ')).toContain('kay: the job scheduled @hourly failed')
      await shutdown(app)
      expect(cron.fired.map(entry => entry.stopped)).toEqual([true, true, true, true])
    }
    finally {
      logged.mockRestore()
      cron.restore()
    }
  })

  it('numbers the locks of several jobs sharing one, each taken once across processes', async () => {
    const cron = fakeCron()
    const path = await jobsPath()
    const runs: string[] = []

    setSystemTime(new Date('2026-01-01T12:00:00Z'))

    const process = (name: string) => new Elysia().use(schedule('@hourly', [() => runs.push(`${name}-a`), () => runs.push(`${name}-b`)], { lock: 'report', store: sqliteJobs(path) })).listen(0)
    const first = process('first')
    const second = process('second')

    try {
      await Promise.all(cron.fired.map(async entry => entry.handler()))
      expect(runs.toSorted()).toEqual(['first-a', 'first-b'])
    }
    finally {
      setSystemTime()
      cron.restore()
      await Promise.all([shutdown(first), shutdown(second)])
    }
  })

  it('runs the jobs once as the server starts with boot, the lock taken and a stop waiting for the run', async () => {
    const cron = fakeCron()
    const path = await jobsPath()
    const runs: string[] = []

    setSystemTime(new Date('2026-01-01T12:00:00Z'))

    const app = new Elysia().use(schedule('@daily', async () => {
      await Bun.sleep(20)
      runs.push('cron')
    }, { boot: true, lock: 'boot', store: sqliteJobs(path) }))
    const other = new Elysia().use(schedule('@hourly', () => runs.push('other'), { boot: true, lock: 'boot', store: sqliteJobs(path) }))

    try {
      app.listen(0)
      other.listen(0)
      await shutdown(app)
      expect(runs).toEqual(['cron'])
      expect(cron.fired[0]!.stopped).toBe(true)
      await shutdown(other)
      expect(runs).toEqual(['cron'])
    }
    finally {
      setSystemTime()
      cron.restore()
    }
  })

  it('never runs a boot run and a scheduled one at once', async () => {
    const cron = fakeCron()
    let active = 0
    let overlapped = false
    const app = new Elysia().use(schedule('@hourly', async () => {
      active++
      overlapped ||= active > 1
      await Bun.sleep(30)
      active--
    }, { boot: true })).listen(0)

    try {
      await cron.fired[0]!.handler()
      expect(overlapped).toBe(false)
    }
    finally {
      await shutdown(app)
      cron.restore()
    }
  })

  it('keeps a boot just before a run is due from taking that run\'s lock', async () => {
    const cron = fakeCron()
    const path = await jobsPath()
    const runs: string[] = []

    setSystemTime(new Date('2026-01-01T11:59:40Z'))

    const app = new Elysia().use(schedule('@hourly', () => runs.push('run'), { boot: true, lock: 'report', store: sqliteJobs(path) })).listen(0)

    try {
      await shutdown(app)
      expect(runs).toEqual(['run'])
      setSystemTime(new Date('2026-01-01T12:00:00Z'))
      await cron.fired[0]!.handler()
      expect(runs).toEqual(['run', 'run'])
    }
    finally {
      setSystemTime()
      cron.restore()
    }
  })

  it.each([
    ['a list in a table', () => schedule({ '@hourly': ['purge'] as unknown as (() => void)[] }), '@hourly'],
    ['a list', () => schedule('@hourly', ['purge'] as unknown as (() => void)[]), '@hourly'],
    ['a string in a table', () => schedule({ '@hourly': 'purge' as unknown as () => void }), '@hourly'],
    ['a string beside a function in a table', () => schedule({ '@hourly': () => undefined, '30s': 'purge' as unknown as () => void }), '30s'],
  ])('refuses a job that is no function when the schedule is built: %s', (_name, build, scheduled) => {
    expect(build).toThrow(`the job scheduled ${scheduled} is no function`)
  })

  it('names the lock of each job of a list, a table and a boot run', async () => {
    const cron = fakeCron()
    const names: string[] = []
    const store = memoryJobs()
    const lock = store.lock.bind(store)
    const job = () => undefined

    store.lock = async (name, slot) => {
      names.push(name)

      return lock(name, slot)
    }

    setSystemTime(new Date('2026-01-01T12:00:00Z'))

    const apps = [
      new Elysia().use(schedule('@hourly', [job, job], { lock: 'list', store })),
      new Elysia().use(schedule({ '@hourly': job, '@daily': [job, job] }, { lock: 'table', store })),
      new Elysia().use(schedule('@hourly', [job, job], { lock: 'boots', boot: true, store })),
      new Elysia().use(schedule('@hourly', job, { lock: 'single', boot: true, store })),
    ]

    try {
      for (const app of apps)
        app.listen(0)

      await Promise.all(cron.fired.map(async entry => entry.handler()))
      await Promise.all(apps.map(async app => shutdown(app)))
      expect(names.toSorted()).toEqual([
        'boots:@hourly:0',
        'boots:@hourly:0:boot',
        'boots:@hourly:1',
        'boots:@hourly:1:boot',
        'list:@hourly:0',
        'list:@hourly:1',
        'single',
        'single:boot',
        'table:@daily:0',
        'table:@daily:1',
        'table:@hourly:0',
      ])
    }
    finally {
      setSystemTime()
      cron.restore()
    }
  })

  it('runs a job at boot only when asked to', async () => {
    const cron = fakeCron()
    const runs: string[] = []
    const app = new Elysia().use(schedule({ '@daily': () => runs.push('daily') })).use(schedule('30s', () => runs.push('every'), { boot: true })).listen(0)

    try {
      await shutdown(app)
      expect(runs).toEqual(['every'])
    }
    finally {
      cron.restore()
    }
  })

  it('types a table by its keys, refusing a schedule that never comes or a length that is not positive', () => {
    const typed = (_build: () => unknown) => true

    expect(typed(() => schedule({ '@hourly': () => undefined, '30 2 * * MON': [() => undefined], '30s': () => undefined }, { tz: 'Europe/Paris', boot: true }))).toBe(true)
    // @ts-expect-error -- no such nickname
    expect(typed(() => schedule({ '@minutely': () => undefined }))).toBe(true)
    // @ts-expect-error -- February has no 30th
    expect(typed(() => schedule({ '0 0 30 feb *': () => undefined }))).toBe(true)
    // @ts-expect-error -- not a function
    expect(typed(() => schedule({ '@hourly': 'purge' }))).toBe(true)
  })

  it('runs a locked schedule once across processes sharing its store, each minute it comes', async () => {
    const cron = fakeCron()
    const path = await jobsPath()
    const runs: string[] = []

    // A slot is a minute rounded, so a clock reaching :30 between the two claims, as on a busy machine, would name two slots.
    setSystemTime(new Date('2026-01-01T12:00:00Z'))
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

  describe('without a lock', () => {
    // Two processes of one app, each building the same schedules in the same order against one store file.
    async function twoProcesses(env: string, build: (name: string, store: ReturnType<typeof sqliteJobs>, schedule: typeof scheduleOf) => Elysia[]) {
      const cron = fakeCron()
      const path = await jobsPath()
      const before = process.env.NODE_ENV ?? 'test'
      const names = ['first', 'second']

      process.env.NODE_ENV = env
      setSystemTime(new Date('2026-01-01T12:00:00Z'))

      // A copy of the module for each process, as the names the schedules of a process hold are its own.
      const apps = (await Promise.all(names.map(async (name) => {
        const copy = await import(`../src/server/jobs.ts?process=${name}-${++copies}`) as { schedule: typeof scheduleOf }

        return build(name, sqliteJobs(path), copy.schedule)
      }))).flat()

      for (const app of apps)
        app.listen(0)

      return {
        async fire() {
          await Promise.all(cron.fired.map(async entry => entry.handler()))
        },
        async done() {
          setSystemTime()
          process.env.NODE_ENV = before
          cron.restore()
          await Promise.all(apps.map(async app => shutdown(app)))
        },
      }
    }

    it('runs once across the processes of a production server', async () => {
      const runs: string[] = []
      const world = await twoProcesses('production', (name, store, schedule) => [new Elysia().use(schedule('@hourly', () => runs.push(`${name}-report`), { store }))])

      try {
        await world.fire()
        expect(runs).toEqual(['first-report'])
      }
      finally {
        await world.done()
      }
    })

    it('keeps jobs apart that share a schedule, a twin job included, each running once across processes', async () => {
      const runs: string[] = []
      const send = (kind: string, name: string) => () => runs.push(`${name}-${kind}`)
      const world = await twoProcesses('production', (name, store, schedule) => [
        new Elysia().use(schedule('@hourly', () => runs.push(`${name}-digest`), { store })).use(schedule('@hourly', () => runs.push(`${name}-purge`), { store })),
        new Elysia().use(schedule('@hourly', send('a', name), { store })).use(schedule('@hourly', send('b', name), { store })),
        new Elysia().use(schedule({ '@daily': [send('c', name), send('d', name)] }, { store })),
      ])

      try {
        await world.fire()
        expect(runs.map(run => run.slice(run.indexOf('-') + 1)).toSorted()).toEqual(['a', 'b', 'c', 'd', 'digest', 'purge'])
      }
      finally {
        await world.done()
      }
    })

    it('locks an every-so-long schedule and its boot run by default too', async () => {
      const runs: string[] = []
      const world = await twoProcesses('production', (name, store, schedule) => [new Elysia().use(schedule('30s', () => runs.push(name), { boot: true, store }))])

      try {
        await Bun.sleep(20)
        expect(runs).toEqual(['first'])
      }
      finally {
        await world.done()
      }
    })

    it('keeps one process per schedule outside production, and with lock false', async () => {
      const runs: string[] = []
      const dev = await twoProcesses('development', (name, store, schedule) => [new Elysia().use(schedule('@hourly', () => runs.push(`dev-${name}`), { store }))])

      try {
        await dev.fire()
      }
      finally {
        await dev.done()
      }

      const off = await twoProcesses('production', (name, store, schedule) => [new Elysia().use(schedule('@hourly', () => runs.push(`off-${name}`), { lock: false, store }))])

      try {
        await off.fire()
        expect(runs.toSorted()).toEqual(['dev-first', 'dev-second', 'off-first', 'off-second'])
      }
      finally {
        await off.done()
      }
    })

    it('frees the lock name when the server stops, so a restart takes it again', async () => {
      const cron = fakeCron()
      const before = process.env.NODE_ENV ?? 'test'
      const store = memoryJobs()
      const names: string[] = []
      const lock = store.lock.bind(store)

      store.lock = async (name, slot) => {
        names.push(name)

        return lock(name, slot)
      }

      process.env.NODE_ENV = 'production'

      try {
        for (let boot = 0; boot < 2; boot++) {
          const app = new Elysia().use(schedule('@hourly', () => undefined, { store })).listen(0)

          await cron.fired.at(-1)!.handler()
          await shutdown(app)
        }

        expect(new Set(names).size).toBe(1)
      }
      finally {
        process.env.NODE_ENV = before
        cron.restore()
      }
    })
  })

  describe('timeout', () => {
    it('frees the schedule from a run that never settles, aborting its signal, and lets a stop through', async () => {
      const cron = fakeCron()
      const logged = spyOn(console, 'error').mockImplementation(() => undefined)
      const signals: AbortSignal[] = []
      const app = new Elysia().use(schedule('@hourly', async (signal) => {
        signals.push(signal)

        if (signals.length === 1)
          await new Promise(() => undefined)
      }, { timeout: '30ms' })).listen(0)

      try {
        await cron.fired[0]!.handler()
        expect(signals[0]!.aborted).toBe(true)
        expect(logged.mock.calls.flat().join(' ')).toContain('it ran past its timeout')
        await cron.fired[0]!.handler()
        expect(signals).toHaveLength(2)
        expect(signals[1]!.aborted).toBe(false)
      }
      finally {
        await shutdown(app)
        logged.mockRestore()
        cron.restore()
      }
    })

    it('aborts the signal of a run in progress as the server stops, and a stop waits no longer than the timeout', async () => {
      const cron = fakeCron()
      const logged = spyOn(console, 'error').mockImplementation(() => undefined)
      let signal: AbortSignal | undefined
      const app = new Elysia().use(schedule('@hourly', async (given) => {
        signal = given
        await new Promise(() => undefined)
      }, { timeout: '40ms' })).listen(0)

      try {
        void cron.fired[0]!.handler()
        await until(() => signal !== undefined)

        const started = Date.now()

        await shutdown(app)
        expect(signal!.aborted).toBe(true)
        expect(Date.now() - started).toBeLessThan(2000)
      }
      finally {
        logged.mockRestore()
        cron.restore()
      }
    })

    it('reports no failure for a run the stop cut short by its signal', async () => {
      const cron = fakeCron()
      const logged = spyOn(console, 'error').mockImplementation(() => undefined)
      let started = false
      const app = new Elysia().use(schedule('@hourly', async (signal) => {
        started = true
        await new Promise(resolve => signal.addEventListener('abort', resolve))

        throw new Error('aborted')
      })).listen(0)

      try {
        const run = cron.fired[0]!.handler()

        await until(() => started)
        await shutdown(app)
        await run
        expect(logged).not.toHaveBeenCalled()
      }
      finally {
        logged.mockRestore()
        cron.restore()
      }
    })

    it('refuses a timeout that is not a duration at boot, and takes false for no limit', () => {
      expect(() => schedule('@hourly', () => undefined, { timeout: 0 })).toThrow('the timeout of the schedule @hourly is 0')
      expect(() => schedule('@hourly', () => undefined, { timeout: false })).not.toThrow()
    })
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

describe('schedule every so long', () => {
  // A run settles over a few microtasks, which fake timers never wait for.
  const settle = async () => {
    for (let tick = 0; tick < 20; tick++)
      await Promise.resolve()
  }

  it('runs on the epoch\'s multiples of its length, planning the next once the last settles, until the server stops', async () => {
    jest.useFakeTimers({ now: 45_000 })

    const runs: number[] = []
    let finish: (() => void) | undefined
    const app = new Elysia().use(schedule('30s', async () => {
      runs.push(Date.now())
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    }))

    try {
      jest.advanceTimersByTime(60_000)
      expect(runs).toEqual([])

      app.listen(0)
      jest.advanceTimersByTime(14_999)
      expect(runs).toEqual([])
      jest.advanceTimersByTime(1)
      await settle()
      // The run takes 40 s, past the 150 s one, so the 180 s one is the next.
      jest.advanceTimersByTime(40_000)
      finish?.()
      await settle()
      expect(runs).toEqual([120_000])
      jest.advanceTimersByTime(19_999)
      expect(runs).toEqual([120_000])
      jest.advanceTimersByTime(1)
      await settle()
      expect(runs).toEqual([120_000, 180_000])
      finish?.()
      await shutdown(app)
      jest.advanceTimersByTime(300_000)
      expect([runs.length, jest.getTimerCount()]).toEqual([2, 0])
    }
    finally {
      jest.useRealTimers()
    }
  })

  it('skips a run whose lock the store cannot make, rather than running unlocked, and runs the next one', async () => {
    const cron = fakeCron()
    const store = memoryJobs()
    const lock = store.lock.bind(store)
    const runs: string[] = []
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    let busy = true

    store.lock = async (name, slot) => {
      if (busy)
        throw new Error('database is locked')

      return lock(name, slot)
    }

    const app = new Elysia().use(schedule('@hourly', () => runs.push('run'), { lock: 'busy', store })).listen(0)

    try {
      setSystemTime(new Date('2026-01-01T12:00:00Z'))
      await Promise.all(cron.fired.map(async entry => entry.handler()))
      expect(runs).toEqual([])
      expect(logged).toHaveBeenCalledTimes(1)

      busy = false
      await Promise.all(cron.fired.map(async entry => entry.handler()))
      expect(runs).toEqual(['run'])
    }
    finally {
      setSystemTime()
      logged.mockRestore()
      cron.restore()
      await shutdown(app)
    }
  })

  it('waits out another process holding the job store while it opens, rather than failing', async () => {
    const path = await jobsPath()

    mkdirSync(dirname(path), { recursive: true })

    // A rollback-journal file another process holds a write on, as one just created by a process still switching it to WAL.
    const holder = Bun.spawn([process.execPath, '-e', `const { Database } = require('bun:sqlite'); const db = new Database(${JSON.stringify(path)}, { create: true }); db.run('CREATE TABLE t (a)'); db.run('BEGIN EXCLUSIVE'); console.log('held'); setTimeout(() => process.exit(0), 600)`], { stdout: 'pipe' })

    try {
      await holder.stdout.getReader().read()
      expect(() => openSqlite(path).close()).not.toThrow()
    }
    finally {
      holder.kill()
    }
  })

  it('runs a locked schedule once across processes sharing its store, each time it comes', async () => {
    jest.useFakeTimers({ now: 0 })

    const store = memoryJobs()
    const runs: string[] = []
    const first = new Elysia().use(schedule(2, () => runs.push('first'), { lock: 'sync', store })).listen(0)
    const second = new Elysia().use(schedule(2, () => runs.push('second'), { lock: 'sync', store })).listen(0)

    try {
      for (let tick = 0; tick < 3; tick++) {
        jest.advanceTimersByTime(2000)
        await settle()
      }

      expect(runs).toHaveLength(3)
    }
    finally {
      jest.useRealTimers()
      await shutdown(first)
      await shutdown(second)
    }
  })

  it('refuses a length that is not positive, or a time zone, at boot, and types a literal one', () => {
    const typed = (_build: () => unknown) => true
    const computed = (every: number) => every

    expect(() => schedule(computed(0), () => undefined)).toThrow('the schedule 0 is 0; it takes a positive duration')
    expect(() => schedule('30s', () => undefined, { tz: 'UTC' } as object)).toThrow('the schedule 30s takes no tz')
    expect(typed(() => [schedule(30, () => undefined), schedule('1.5h', () => undefined), schedule('1d', () => undefined, { lock: 'daily' })])).toBe(true)
    // @ts-expect-error -- not positive
    expect(typed(() => schedule('0s', () => undefined))).toBe(true)
    // @ts-expect-error -- a time zone means nothing to a schedule running from the epoch
    expect(typed(() => schedule('30s', () => undefined, { tz: 'UTC' }))).toBe(true)
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

describe('errors outside a request', () => {
  it('hands a failed schedule, background job and onStop hook to onError with no request, and logs a reporter that throws', async () => {
    const cron = fakeCron()
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const caught: [string, unknown][] = []

    useAppOnError((error, request) => {
      caught.push([(error as Error).message, request])

      if ((error as Error).message === 'stop failed')
        throw new Error('Tracker down')
    })

    try {
      const app = new Elysia()
        .use(schedule('@hourly', () => { throw new Error('nightly failed') }))
        .use(background(() => { throw new Error('consumer failed') }))
        .onStop(() => { throw new Error('stop failed') })

      app.listen(0)
      await cron.fired[0]!.handler()
      await shutdown(app)
      await Bun.sleep(5)

      expect(caught.toSorted()).toEqual([['consumer failed', undefined], ['nightly failed', undefined], ['stop failed', undefined]])
      expect(logged.mock.calls.flat().join('\n')).toContain('Tracker down')
    }
    finally {
      useAppOnError(undefined)
      logged.mockRestore()
      cron.restore()
      process.exitCode = 0
    }
  })
})

describe('a slow onError', () => {
  it('holds a background report for the timeout at most, logging it, and a fast or failing one returns at once', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      useAppOnError(async () => new Promise<void>(() => undefined))

      const started = Date.now()

      await reportBackgroundError('a job failed', new Error('stuck'), 30)

      expect(Date.now() - started).toBeLessThan(2000)
      expect(logged.mock.calls.flat().join('\n')).toContain('onError did not finish in 30 ms')

      logged.mockClear()
      useAppOnError(async () => {
        throw new Error('Tracker down')
      })
      await reportBackgroundError('a job failed', new Error('again'), 60_000)

      expect(logged.mock.calls.flat().join('\n')).toContain('Tracker down')
      expect(logged.mock.calls.flat().join('\n')).not.toContain('did not finish')
    }
    finally {
      useAppOnError(undefined)
      logged.mockRestore()
    }
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

  it('leaves a missing SQLite file alone until a job is enqueued, then runs it', async () => {
    const path = await jobsPath()
    const errors = spyOn(console, 'error')
    const sent: string[] = []
    const mail = queue('mail', (to: string) => void sent.push(to), { store: sqliteJobs(path) })
    const app = new Elysia().use(mail).listen(0)

    try {
      await Bun.sleep(50)
      expect(await Bun.file(path).exists()).toBe(false)
      expect(errors).not.toHaveBeenCalled()
      // Another process's store, creating the file the worker then opens.
      await queue('mail', () => undefined, { store: sqliteJobs(path) }).enqueue('ada@example.com')
      await until(() => sent.length > 0)
      expect(sent).toEqual(['ada@example.com'])
    }
    finally {
      errors.mockRestore()
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

  it('retries a failing job after a doubling wait, logging each retry, then keeps it as failed and hands it to onFailed', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)
    const tries: number[] = []
    const gaveUp: unknown[] = []
    const tracked: unknown[] = []
    const flaky = queue('flaky', (n: number) => {
      tries.push(n)

      throw new Error('mail server down')
    }, { store: memoryJobs(), attempts: 3, backoff: '10s', onFailed: (n, error) => void gaveUp.push([n, (error as Error).message]) })

    useAppOnError((error, request) => void tracked.push([(error as Error).message, request]))

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
      expect(tracked).toEqual([['mail server down', undefined]])
      expect(await flaky.failed()).toEqual([{ id: expect.any(String), payload: 1, attempts: 3, error: 'mail server down' }])
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^kay: a job of queue\('flaky'\) failed 3 times and is kept as failed\nError: mail server down\n/))
      expect(warned.mock.calls).toEqual([
        ['kay: a job of queue(\'flaky\') failed, attempt 1 of 3, and runs again in 10 s: mail server down'],
        ['kay: a job of queue(\'flaky\') failed, attempt 2 of 3, and runs again in 20 s: mail server down'],
      ])

      setSystemTime(Date.now() + 3_600_000)
      expect(await flaky.drain()).toBe(0)
    }
    finally {
      useAppOnError(undefined)
      setSystemTime()
      logged.mockRestore()
      warned.mockRestore()
    }
  })

  it.each(['memory', 'sqlite', 'without purge'])('drops a failed job once keepFailed has passed since its last attempt, and keeps it for good on false, in a %s store', async (kind) => {
    const failing = async (keepFailed?: false) => {
      const store = kind === 'sqlite' ? sqliteJobs(await jobsPath()) : memoryJobs()

      if (kind === 'without purge')
        store.purge = undefined

      return queue('failing', () => {
        throw new Error('no such mailbox')
      }, { store, attempts: 1, keepFailed, onFailed: () => undefined })
    }
    const kept = await failing()
    const forever = await failing(false)
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await kept.enqueue('ada@example.com')
      await forever.enqueue('ada@example.com')
      await kept.drain()
      await forever.drain()
      setSystemTime(Date.now() + 29 * 24 * 3_600_000)
      await kept.drain()
      expect(await kept.failed()).toHaveLength(1)
      setSystemTime(Date.now() + 2 * 24 * 3_600_000)
      await kept.drain()
      await forever.drain()
      expect(await kept.failed()).toEqual([])
      expect(await forever.failed()).toHaveLength(1)
    }
    finally {
      setSystemTime()
      logged.mockRestore()
    }
  })

  it.each(['memory', 'sqlite'])('removes a job by id, or every waiting and failed job whose payload matches, from a %s store', async (kind) => {
    const mail = queue('erase', (to: string) => {
      if (to === 'bounce@example.com')
        throw new Error('no such mailbox')
    }, { store: kind === 'memory' ? memoryJobs() : sqliteJobs(await jobsPath()), attempts: 1, onFailed: () => undefined })
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await mail.enqueue('bounce@example.com')
      await mail.drain()
      await mail.enqueue('ada@example.com', { delay: '1h' })
      await mail.enqueue('ada@example.com', { delay: '2h' })
      const grace = await mail.enqueue('grace@example.com', { delay: '1h' })

      expect(await mail.remove(to => to === 'ada@example.com' || to === 'bounce@example.com')).toBe(3)
      expect(await mail.failed()).toEqual([])
      expect(await mail.remove(grace)).toBe(1)
      expect([await mail.remove(grace), await mail.remove('no-such-job')]).toEqual([0, 0])
      setSystemTime(Date.now() + 3 * 3_600_000)
      expect(await mail.drain()).toBe(0)
    }
    finally {
      setSystemTime()
      logged.mockRestore()
    }
  })

  it('logs a store that fails once as its outage starts and once as it ends, whatever the concurrency', async () => {
    const store = memoryJobs()
    const claim = store.claim.bind(store)
    let failing = true
    const ran: number[] = []
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const told = spyOn(console, 'log').mockImplementation(() => undefined)

    store.claim = async (...args) => {
      if (failing)
        throw new Error('database is locked')

      return claim(...args)
    }

    const outage = queue('outage', (n: number) => void ran.push(n), { store, concurrency: 3 })
    const app = new Elysia().use(outage).listen(0)

    try {
      await outage.enqueue(1)
      await until(() => logged.mock.calls.length > 0)
      await Bun.sleep(50)
      failing = false
      await until(() => ran.length > 0)
      expect(logged.mock.calls).toEqual([[expect.stringMatching(/^kay: queue\('outage'\) could not read its store; its workers ask it again less and less often until it answers\nError: database is locked\n/)]])
      expect(told.mock.calls).toEqual([['kay: queue(\'outage\') reads its store again']])
    }
    finally {
      await shutdown(app)
      logged.mockRestore()
      told.mockRestore()
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

  it('keeps as failed, without running it, a job whose process died during each of its attempts', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const store = memoryJobs()
    const runs: string[] = []
    const gaveUp: string[] = []
    const crashing = queue('crashing', (name: string) => void runs.push(name), { store, attempts: 2, lostAfter: '1m', onFailed: (name, error) => void gaveUp.push(`${name}: ${(error as Error).message}`) })

    try {
      await crashing.enqueue('huge import')

      // Two processes take it in turn, each dying before marking how it went.
      for (let crash = 0; crash < 2; crash++) {
        expect(await store.claim('crashing', Date.now(), Date.now() + 60_000)).toBeDefined()
        setSystemTime(Date.now() + 61_000)
      }

      expect(await crashing.drain()).toBe(1)
      expect(runs).toEqual([])
      expect(gaveUp).toEqual(['huge import: it was taken 2 times, as many as its 2 attempts, its last run never finishing'])
      expect(await crashing.failed()).toEqual([{ id: expect.any(String), payload: 'huge import', attempts: 3, error: 'it was taken 2 times, as many as its 2 attempts, its last run never finishing' }])
    }
    finally {
      setSystemTime()
      logged.mockRestore()
    }
  })

  it('aborts the signal of a run at lostAfter, so a handler that listens stops before another process retries the job', async () => {
    const logged = spyOn(console, 'warn').mockImplementation(() => undefined)
    const events: string[] = []
    const slow = queue('mails', async (name: string, signal: AbortSignal) => {
      events.push(`start ${name}`)
      await new Promise(resolve => signal.addEventListener('abort', resolve))
      events.push(`stopped ${name}`)
    }, { store: memoryJobs(), lostAfter: '300ms', attempts: 2 })

    try {
      await slow.enqueue('digest')
      expect(await slow.drain()).toBe(1)
      expect(events).toEqual(['start digest', 'stopped digest'])
      await slow.remove(() => true)
    }
    finally {
      logged.mockRestore()
    }
  })

  describe('on shutdown', () => {
    // A queue on a store two processes share, started like a server, its handler waiting on its signal.
    async function stopping(store: JobStore, handler: (signal: AbortSignal) => unknown) {
      let started = false
      const mails = queue('mails', async (_payload: string, signal: AbortSignal) => {
        started = true

        return handler(signal)
      }, { store, attempts: 3, backoff: '1m' })

      await mails.enqueue('digest')

      const app = new Elysia().use(mails).listen(0)

      await until(() => started)

      return { mails, app }
    }

    const aborted = async (signal: AbortSignal) => {
      await new Promise(resolve => signal.addEventListener('abort', resolve))

      throw new Error('aborted')
    }

    it.each([
      ['memory', async () => memoryJobs()],
      ['sqlite', async () => sqliteJobs(await jobsPath())],
    ])('releases the job it was running, its attempt given back, for the next process to take at once: %s', async (_name, open) => {
      const store = await open()
      const { mails, app } = await stopping(store, aborted)

      await shutdown(app)

      const taken = await store.claim('mails', Date.now(), Date.now() + 60_000)

      expect(taken).toMatchObject({ queue: 'mails', attempts: 1 })
      expect(taken?.error).toBeUndefined()
      // The queue stays in the set kay/test drains, so nothing of it may be left waiting.
      await mails.remove(() => true)
    })

    it('hands back a job whose claim resolved after the stop, without running it', async () => {
      const store = memoryJobs()
      const claim = store.claim.bind(store)
      const runs: string[] = []
      let open: (() => void) | undefined
      let asked = false

      store.claim = async (name, now, until) => {
        if (asked)
          return claim(name, now, until)

        asked = true
        await new Promise<void>((resolve) => {
          open = resolve
        })

        return claim(name, now, until)
      }

      const mails = queue('mails', (payload: string) => void runs.push(payload), { store })

      await mails.enqueue('digest')

      const app = new Elysia().use(mails).listen(0)

      await until(() => asked)

      const stopped = shutdown(app)

      // The stop reaches the queue after the server has closed.
      await Bun.sleep(20)
      open?.()
      await stopped
      expect(runs).toEqual([])
      expect(await claim('mails', Date.now(), Date.now() + 60_000)).toMatchObject({ attempts: 1 })
      await mails.remove(() => true)
    })

    it('completes a job whose handler finishes despite the stop', async () => {
      const store = memoryJobs()
      const { mails, app } = await stopping(store, async (signal) => {
        await new Promise(resolve => signal.addEventListener('abort', resolve))
      })

      await shutdown(app)
      expect(await store.claim('mails', Date.now(), Date.now() + 60_000)).toBeUndefined()
      expect(await mails.failed()).toEqual([])
    })

    it('retries as before on a store with no release', async () => {
      const logged = spyOn(console, 'warn').mockImplementation(() => undefined)
      const store = memoryJobs()

      delete (store as { release?: unknown }).release

      try {
        const { mails, app } = await stopping(store, aborted)

        await shutdown(app)
        expect(await store.claim('mails', Date.now(), Date.now() + 60_000)).toBeUndefined()
        expect(await store.nextRunAt('mails')).toBeGreaterThan(Date.now() + 50_000)
        await mails.remove(() => true)
      }
      finally {
        logged.mockRestore()
      }
    })
  })

  it('fails a run that outlasts lostAfter, freeing its worker for the next job', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const runs: string[] = []
    const slow = queue('slow', async (name: string) => {
      runs.push(name)

      if (name === 'stuck')
        await new Promise(() => undefined)
    }, { store: memoryJobs(), lostAfter: '1s', attempts: 1 })

    try {
      await slow.enqueue('stuck')
      await slow.enqueue('next')
      expect(await slow.drain()).toBe(2)
      expect(runs).toEqual(['stuck', 'next'])
      expect(await slow.failed()).toEqual([{ id: expect.any(String), payload: 'stuck', attempts: 1, error: 'it ran past lostAfter, 1 s' }])
    }
    finally {
      logged.mockRestore()
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

  it.each([
    ['attempts that is no whole number of at least 1', { attempts: 0 }, 'attempts is 0'],
    ['a concurrency that is no whole number of at least 1', { concurrency: 1.5 }, 'concurrency is 1.5'],
    ['a backoff that is no positive duration', { backoff: '0s' as never }, 'backoff'],
    ['an idlePoll of 0', { idlePoll: 0 }, 'idlePoll'],
    ['an idlePoll in milliseconds', { idlePoll: '500ms' as never }, 'idlePoll'],
    ['an idlePoll shorter than the 1 s poll', { idlePoll: 0.5 }, 'idlePoll is 0.5; it takes a duration of at least 1 second'],
  ])('refuses %s', (_name, options, message) => {
    expect(() => queue('x', () => undefined, options)).toThrow(message)
  })

  it('takes an idlePoll of the 1 s poll', () => {
    expect(() => queue('x', () => undefined, { idlePoll: '1s' })).not.toThrow()
  })

  describe('while idle', () => {
    // Fake timers never wait for a store's promises, so each step flushes them.
    const flush = async () => {
      for (let tick = 0; tick < 20; tick++)
        await Promise.resolve()
    }

    // Starts a worker over a store counting its claims, and returns how many looks each second of fake time brings.
    const watch = async (options: { idlePoll?: number, concurrency?: number, backoff?: number, handler?: (payload: string) => unknown }) => {
      const store = memoryJobs()
      const claim = store.claim.bind(store)
      const claims: number[] = []
      const ran: string[] = []

      store.claim = async (name, now, until) => {
        claims.push(Date.now())

        return claim(name, now, until)
      }

      const { handler, ...rest } = options
      const work = queue('idle', async (payload: string) => {
        ran.push(payload)
        await handler?.(payload)
      }, { store, ...rest })
      const app = new Elysia().use(work).listen(0)

      await flush()

      return {
        work,
        app,
        store,
        claims,
        ran,
        async advance(ms: number) {
          for (let elapsed = 0; elapsed < ms; elapsed += 100) {
            jest.advanceTimersByTime(100)
            await flush()
          }
        },
      }
    }

    it('backs off to 10 seconds by default, and idlePoll 1s keeps the poll every second', async () => {
      jest.useFakeTimers({ now: 0 })

      const idle = await watch({})
      const steady = await watch({ idlePoll: 1 })

      try {
        // One clock runs both queues.
        await idle.advance(30_000)
        expect(idle.claims).toEqual([0, 1000, 3000, 7000, 15_000, 25_000])
        expect(steady.claims.filter(at => at <= 5000)).toEqual([0, 1000, 2000, 3000, 4000, 5000])
      }
      finally {
        jest.useRealTimers()
        await shutdown(idle.app)
        await shutdown(steady.app)
      }
    })

    it('has one worker of a queue look at the store while idle', async () => {
      jest.useFakeTimers({ now: 0 })

      const idle = await watch({ concurrency: 4 })

      try {
        await idle.advance(10_000)
        // The four workers' first looks, then one poller.
        expect(idle.claims.filter(at => at > 0)).toEqual([1000, 3000, 7000])
      }
      finally {
        jest.useRealTimers()
        await shutdown(idle.app)
      }
    })

    it('wakes the worker looking for jobs on an enqueue, and one sleeping worker on a claim, not all of them', async () => {
      jest.useFakeTimers({ now: 0 })

      const idle = await watch({ concurrency: 8 })

      try {
        await idle.advance(20_000)
        idle.claims.length = 0
        await idle.work.enqueue('a')
        await flush()
        expect(idle.ran).toEqual(['a'])
        // The poller's claim finds the job, the worker woken to take over looks, and the poller looks once more after the run.
        expect(idle.claims).toHaveLength(3)
      }
      finally {
        jest.useRealTimers()
        await shutdown(idle.app)
      }
    })

    it('hands the look to a sleeping worker while a job runs, so jobs enqueued then run at once, one worker after another', async () => {
      jest.useFakeTimers({ now: 0 })

      const release = Promise.withResolvers<void>()
      const idle = await watch({ concurrency: 3, handler: async (payload: string) => {
        if (payload === 'slow')
          await release.promise
      } })

      try {
        await idle.advance(20_000)
        await idle.work.enqueue('slow')
        await flush()
        await idle.work.enqueue('q1')
        await flush()
        await idle.work.enqueue('q2')
        await flush()
        // No time passed: each enqueue woke whoever looked, and each claim woke a sleeper to look next.
        expect(idle.ran).toEqual(['slow', 'q1', 'q2'])
        release.resolve()
      }
      finally {
        jest.useRealTimers()
        await shutdown(idle.app)
      }
    })

    it('wakes a poller waiting out a store outage on an enqueue', async () => {
      jest.useFakeTimers({ now: 0 })

      const idle = await watch({ concurrency: 2 })
      const claim = idle.store.claim.bind(idle.store)
      let down = true

      try {
        await idle.advance(5000)
        idle.store.claim = async (name, now, until) => {
          if (down)
            throw new Error('locked')

          return claim(name, now, until)
        }
        await idle.advance(20_000)
        down = false
        await idle.work.enqueue('a')
        await flush()
        expect(idle.ran).toEqual(['a'])
      }
      finally {
        jest.useRealTimers()
        await shutdown(idle.app)
      }
    })

    it('notices a job another process enqueued within idlePoll, and with a job running another worker takes over the look', async () => {
      jest.useFakeTimers({ now: 0 })

      const release = Promise.withResolvers<void>()
      const idle = await watch({ concurrency: 2, handler: async (payload: string) => {
        if (payload === 'slow')
          await release.promise
      } })

      try {
        await idle.advance(20_000)
        await idle.store.add({ id: 'a', queue: 'idle', payload: stringify('slow'), attempts: 0, runAt: Date.now() })
        await idle.advance(10_000)
        expect(idle.ran).toEqual(['slow'])
        // The slow job is running; one worker still looks, so the next job is found.
        await idle.store.add({ id: 'b', queue: 'idle', payload: stringify('quick'), attempts: 0, runAt: Date.now() })
        await idle.advance(10_000)
        expect(idle.ran).toEqual(['slow', 'quick'])
        release.resolve()
      }
      finally {
        jest.useRealTimers()
        await shutdown(idle.app)
      }
    })

    it('stops with a worker whose store answers after the stop, and runs a job enqueued while the poller reads the store', async () => {
      jest.useFakeTimers({ now: 0 })

      const gate = Promise.withResolvers<void>()
      const store = memoryJobs()
      const nextRunAt = store.nextRunAt.bind(store)
      let held = false

      store.nextRunAt = async (name) => {
        held = true
        await gate.promise

        return nextRunAt(name)
      }

      const ran: string[] = []
      const work = queue('gated', (payload: string) => ran.push(payload), { store })
      const app = new Elysia().use(work).listen(0)

      try {
        await flush()
        expect(held).toBe(true)
        // Enqueued while the poller waits on the store: it looks again at once instead of sleeping on.
        await work.enqueue('a')
        gate.resolve()
        await flush()
        expect(ran).toEqual(['a'])
      }
      finally {
        jest.useRealTimers()
        await shutdown(app)
      }
    })

    it('wakes for a job its own retry puts at a time before the wait ends', async () => {
      jest.useFakeTimers({ now: 0 })

      let runs = 0
      const idle = await watch({ backoff: 2, handler: () => {
        if (++runs === 1)
          throw new Error('once')
      } })

      try {
        await idle.advance(20_000)
        await idle.work.enqueue('x')
        await idle.advance(1900)
        expect(runs).toBe(1)
        await idle.advance(300)
        expect(runs).toBe(2)
      }
      finally {
        jest.useRealTimers()
        await shutdown(idle.app)
      }
    })

    it('doubles its wait up to idlePoll, and starts over once a job runs', async () => {
      jest.useFakeTimers({ now: 0 })

      const idle = await watch({ idlePoll: 5 })

      try {
        await idle.advance(20_000)
        expect(idle.claims).toEqual([0, 1000, 3000, 7000, 12_000, 17_000])
        await idle.work.enqueue('now')
        await flush()
        expect(idle.ran).toEqual(['now'])
        await idle.advance(5000)
        expect(idle.claims.slice(6)).toEqual([20_000, 20_000, 21_000, 23_000])
      }
      finally {
        jest.useRealTimers()
        await shutdown(idle.app)
      }
    })

    it('runs a job enqueued in the process at once, however long the wait', async () => {
      jest.useFakeTimers({ now: 0 })

      const idle = await watch({ idlePoll: 60 })

      try {
        await idle.advance(30_000)
        await idle.work.enqueue('a')
        await flush()
        expect(idle.ran).toEqual(['a'])
      }
      finally {
        jest.useRealTimers()
        await shutdown(idle.app)
      }
    })

    it('still wakes for a delayed job when it is due', async () => {
      jest.useFakeTimers({ now: 0 })

      const idle = await watch({ idlePoll: 60 })

      try {
        await idle.advance(30_000)
        await idle.work.enqueue('later', { delay: 10 })
        await idle.advance(9900)
        expect(idle.ran).toEqual([])
        await idle.advance(200)
        expect(idle.ran).toEqual(['later'])
      }
      finally {
        jest.useRealTimers()
        await shutdown(idle.app)
      }
    })
  })
})
