import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { jobRuns } from '../src/runtime/counters'
import { memoryJobs } from '../src/server'
import { hookLifecycle } from '../src/server/app-hooks'
import { runStopHooks } from '../src/server/lifecycle'
import { maintenance, maintenanceOverview, stopMaintenance } from '../src/server/maintenance'
import { drainQueues } from '../src/server/queue'
import { scratchDir } from './scratch'

// An hour is far from the epoch's multiples a test could straddle, so every pass of a test falls in one lock slot.
const HOUR = 3_600_000

afterEach(() => {
  stopMaintenance()
})

async function until(condition: () => boolean, timeout = 3000): Promise<void> {
  for (const start = Date.now(); !condition(); await Bun.sleep(10)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

async function production<Result>(work: () => Promise<Result>): Promise<Result> {
  const before = process.env.NODE_ENV

  process.env.NODE_ENV = 'production'

  try {
    return await work()
  }
  finally {
    if (before === undefined)
      delete process.env.NODE_ENV
    else
      process.env.NODE_ENV = before
  }
}

describe('maintenance', () => {
  it('counts each pass in kay_job_runs_total and lists the maintenance in the Jobs tab', async () => {
    const upkeep = maintenance('listed', HOUR, () => undefined)

    await upkeep.run()

    expect(jobRuns.get('maintenance:listed')).toEqual({ ok: 1, failed: 0, skipped: 0 })
    expect(maintenanceOverview().find(view => view.name === 'listed')).toMatchObject({ every: HOUR, last: { at: expect.any(Number) } })
  })

  it('shows a failed pass with its error and goes on', async () => {
    const upkeep = maintenance('broken', HOUR, () => {
      throw new Error('the table is gone')
    })

    await upkeep.run()

    expect(jobRuns.get('maintenance:broken')?.failed).toBe(1)
    expect(maintenanceOverview().find(view => view.name === 'broken')?.last?.error).toBe('the table is gone')
  })

  it('runs a pass once across processes sharing a store in production', async () => {
    const store = memoryJobs()
    const runs: string[] = []
    const first = maintenance('shared', HOUR, () => runs.push('first'), { store })
    const second = maintenance('shared', HOUR, () => runs.push('second'), { store })

    await production(async () => {
      await Promise.all([first.run(), second.run()])
    })

    expect(runs).toHaveLength(1)
    expect(jobRuns.get('maintenance:shared')).toEqual({ ok: 1, failed: 0, skipped: 1 })
  })

  it('runs in every process with lock: false, for what is each host\'s own', async () => {
    const store = memoryJobs()
    const runs: string[] = []
    const first = maintenance('local', HOUR, () => runs.push('first'), { store, lock: false })
    const second = maintenance('local', HOUR, () => runs.push('second'), { store, lock: false })

    await production(async () => {
      await Promise.all([first.run(), second.run()])
    })

    expect(runs.toSorted()).toEqual(['first', 'second'])
  })

  it('runs on its timer until it is stopped, and again once started anew', async () => {
    let runs = 0
    const upkeep = maintenance('ticking', 30, () => void runs++)

    upkeep.start()
    upkeep.start()
    await until(() => runs >= 2)
    upkeep.stop()

    const seen = runs

    await Bun.sleep(100)
    expect(runs).toBe(seen)
    expect(maintenanceOverview().some(view => view.name === 'ticking')).toBe(false)

    upkeep.start()
    await until(() => runs > seen)
  })

  it('runs its first pass after the delay given', async () => {
    let runs = 0
    const upkeep = maintenance('first', HOUR, () => void runs++, { first: 20 })

    upkeep.start()
    expect(runs).toBe(0)
    await until(() => runs === 1)
  })

  it('stops with the server: the timer ends and the pass in progress is aborted', async () => {
    let signal: AbortSignal | undefined
    let runs = 0
    const upkeep = maintenance('stopped', 30, async (given) => {
      runs++
      signal = given
      await new Promise(resolve => given.addEventListener('abort', resolve))
    })
    const app = new Elysia()

    hookLifecycle(app, {})
    upkeep.start()
    await until(() => signal !== undefined)
    await runStopHooks(app)

    expect(signal?.aborted).toBe(true)
    await Bun.sleep(100)
    expect(runs).toBe(1)
    expect(maintenanceOverview().some(view => view.name === 'stopped')).toBe(false)
  })

  it('stops only with the last server of the process, and a server started after a stop arms its own', async () => {
    let runs = 0
    const first = new Elysia()
    const second = new Elysia()

    hookLifecycle(first, {})
    hookLifecycle(second, {})
    await first.modules
    // A server counts from its start.
    for (const app of [first, second]) {
      for (const hook of app.event.start ?? [])
        await hook.fn(app)
    }

    const upkeep = maintenance('shared-by-apps', 30, () => void runs++)

    upkeep.start()
    await runStopHooks(first)
    expect(maintenanceOverview().some(view => view.name === 'shared-by-apps')).toBe(true)
    await until(() => runs >= 1)
    await runStopHooks(second)
    expect(maintenanceOverview().some(view => view.name === 'shared-by-apps')).toBe(false)

    // The reload order: the old apps stopped, then the new app's upkeep armed.
    const reloaded = maintenance('after-reload', 30, () => void runs++)
    const before = runs

    reloaded.start()
    await until(() => runs > before)
  })

  it('creates no default job store in production when the app has none', async () => {
    const cwd = process.cwd()
    const dir = await scratchDir('maintenance-')
    let runs = 0

    process.chdir(dir)

    try {
      await production(async () => {
        await maintenance('no-store', HOUR, () => void runs++).run()
      })
    }
    finally {
      process.chdir(cwd)
    }

    expect(runs).toBe(1)
    expect(existsSync(join(dir, 'data'))).toBe(false)
  })

  it('is waited for by runJobs() while a pass is going', async () => {
    let finished = false
    const upkeep = maintenance('awaited', HOUR, async () => {
      await Bun.sleep(50)
      finished = true
    })

    void upkeep.run()
    await drainQueues()

    expect(finished).toBe(true)
  })

  it('never overlaps two passes', async () => {
    let going = 0
    let most = 0
    const upkeep = maintenance('serial', HOUR, async () => {
      most = Math.max(most, ++going)
      await Bun.sleep(20)
      going--
    })

    await Promise.all([upkeep.run(), upkeep.run(), upkeep.run()])

    expect(most).toBe(1)
  })
})
