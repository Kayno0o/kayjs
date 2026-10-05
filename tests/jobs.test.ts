import { describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { background, schedule, shutdown } from '../src/server'

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
