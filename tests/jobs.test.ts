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

  it('refuses a schedule it cannot read, or one that never comes, at boot', () => {
    expect(() => schedule('every hour', () => undefined)).toThrow('Invalid cron expression')
    expect(() => schedule('0 0 30 2 *', () => undefined)).toThrow('the schedule 0 0 30 2 * never comes')
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
