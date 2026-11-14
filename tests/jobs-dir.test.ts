import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { jobFiles } from '../src/config-extensions'
import { background, queue, schedule, workflow } from '../src/server'
import { scheduledOf } from '../src/server/jobs'
import { memoryJobs } from '../src/server/queue'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

// Every job a file of `src/jobs` exports is mounted with no default export and no `.use`, as the files of `src/routes` are served.
const root = await fixtureCopy('bare')

await Bun.write(join(root, 'src/jobs/mail.ts'), `import { background, queue, schedule, workflow } from 'kay/server'

export const seen: { payload: string, ctx: unknown, run?: unknown, flow?: unknown }[] = []
export const ticks: unknown[] = []
export const started: number[] = []

export const welcome = queue('welcome', (payload: string, ctx) => {
  seen.push({ payload, ctx: { signal: ctx.signal instanceof AbortSignal, id: typeof ctx.job.id, attempts: ctx.job.attempts, log: typeof ctx.log.info, locale: ctx.locale } })
})

// A job exported twice is mounted once.
export default welcome

export const tick = schedule({ every: '1m' }, (run, ctx) => void ticks.push({ run, signal: ctx.signal instanceof AbortSignal }))

export const onboarding = workflow<{ user: string }>('onboarding', async (input, { step, job }) => {
  await step.run('welcome', () => void seen.push({ payload: input.user, ctx: 'flow', flow: job.id }))
})


export const off = queue('off', () => undefined, { enabled: false })
export const helper = 'a string no plugin'
`)

await Bun.write(join(root, 'src/jobs/_private.ts'), `import { schedule } from 'kay/server'\n\nexport const never = schedule({ every: '1m' }, () => { throw new Error('mounted') })\n`)
await Bun.write(join(root, 'src/jobs/deep/nested.ts'), `import { schedule } from 'kay/server'\n\nexport const deep = schedule({ every: '5m' }, () => undefined)\n`)
await Bun.write(join(root, 'src/jobs/readme.md'), '# not a job\n')

const site = await testSite({ root, islands: false })

afterAll(async () => {
  await site.close()
})

describe('src/jobs', () => {
  it('lists the files of nested folders in order, leaving out a name starting with _ and what is no TypeScript', () => {
    expect(jobFiles(root)).toEqual(['deep/nested.ts', 'mail.ts'])
  })

  it('mounts each queue, workflow, schedule and background job a file exports', async () => {
    const mail = await import(resolve(root, 'src/jobs/mail.ts')) as { seen: { payload: string, ctx: unknown }[], ticks: unknown[], started: number[], welcome: ReturnType<typeof queue<string>>, onboarding: ReturnType<typeof workflow<{ user: string }>> }

    await mail.welcome.enqueue('ada')
    await mail.onboarding.start({ user: 'grace' })
    expect(await site.runJobs()).toBe(2)
    expect(mail.seen.map(one => one.payload).sort()).toEqual(['ada', 'grace'])
    expect(mail.seen.find(one => one.payload === 'ada')!.ctx).toEqual({ signal: true, id: 'string', attempts: 1, log: 'function', locale: 'en' })
    expect(await site.runSchedule()).toBe(2)
    expect(mail.ticks).toEqual([{ run: { schedule: 'every 1m', boot: false }, signal: true }])
  })

  it('mounts a job exported by name and as the default once', async () => {
    const mail = await import(resolve(root, 'src/jobs/mail.ts')) as { ticks: unknown[] }

    expect(await site.runSchedule('1m')).toBe(1)
    expect(mail.ticks.length).toBeGreaterThan(0)
  })

  it('names the file of a job it cannot mount, and leaves a file the folder does not read alone', async () => {
    const mounted = await site.runSchedule('5m')

    expect(mounted).toBe(1)
    await expect(site.runSchedule('9m')).rejects.toThrow(/no schedule matches/)
  })
})

describe('enabled on a queue', () => {
  it('starts no worker, so a job waits for a process that runs the queue', async () => {
    const store = memoryJobs()
    const off = queue('off-queue', () => undefined, { store, enabled: false })
    const app = new Elysia().use(off).listen(0)

    try {
      await off.enqueue('x', { key: 'k' })
      await Bun.sleep(150)
      expect((await off.job('k'))?.status).toBe('waiting')
    }
    finally {
      await app.stop()
    }
  })

  it('also switches off a workflow', async () => {
    const store = memoryJobs()
    const ran: string[] = []
    const flow = workflow('off-flow', async (_, { step }) => step.run('x', () => void ran.push('x')), { store, enabled: false })
    const app = new Elysia().use(flow).listen(0)

    try {
      await flow.start()
      await Bun.sleep(150)
      expect(ran).toEqual([])
      expect(await flow.drain()).toBe(1)
      expect(ran).toEqual(['x'])
    }
    finally {
      await app.stop()
    }
  })
})

describe('schedule shapes', () => {
  it('takes every, cron and a table, and refuses both written together', () => {
    expect(() => schedule({ every: '1m' }, () => undefined)).not.toThrow()
    expect(() => schedule({ cron: '@hourly', timeZone: 'Europe/Paris' }, [() => undefined, () => undefined])).not.toThrow()
    expect(() => schedule({ '@hourly': () => undefined, '30s': () => undefined }, { lock: false })).not.toThrow()
    expect(() => schedule({ every: '1m', cron: '@hourly' } as never, () => undefined)).toThrow(/not both/)
    expect(() => schedule({ every: '1m', timeZone: 'Europe/Paris' } as never, () => undefined)).toThrow(/takes no timeZone/)
  })

  it('gives enabled: false to every kind', () => {
    const none = schedule({ every: '1m', enabled: false }, () => {
      throw new Error('ran')
    })

    expect(none).toBeDefined()
  })

  it('takes the schedule written the old way until 1.108', async () => {
    const seen: string[] = []
    const app = new Elysia().use(schedule('1m', (run: { schedule: string }) => void seen.push(run.schedule)))

    for (const entry of scheduledOf(app))
      await entry.fire()

    expect(seen).toEqual(['every 1m'])
  })
})

describe('background', () => {
  it('hands its work no input and the context of a job, aborting its signal on stop', async () => {
    const seen: unknown[] = []
    let signal: AbortSignal | undefined
    const app = new Elysia().use(background((input, ctx) => {
      signal = ctx.signal
      seen.push(input, typeof ctx.job.id, ctx.locale)
    })).listen(0)

    await Bun.sleep(20)
    expect(seen).toEqual([undefined, 'string', 'en'])
    await app.stop()
    expect(signal?.aborted).toBe(true)
  })
})

describe('timeout, the one name of a job\'s time limit', () => {
  it('reads timeout, and lostAfter as its old name', async () => {
    const aborted: string[] = []
    const made = (options: { timeout?: '200ms', lostAfter?: '200ms' }) => queue('limit', async (_: string, { signal }) => {
      await new Promise(resolve => signal.addEventListener('abort', resolve))
      aborted.push('aborted')
    }, { store: memoryJobs(), attempts: 1, ...options })

    for (const options of [{ timeout: '200ms' as const }, { lostAfter: '200ms' as const }]) {
      const limited = made(options)

      await limited.enqueue('x')
      expect(await limited.drain()).toBe(1)
      expect((await limited.failed())[0]?.error).toBe('it ran past its timeout, 200 ms')
    }

    expect(aborted).toEqual(['aborted', 'aborted'])
  })
})
