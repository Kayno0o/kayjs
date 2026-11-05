import type { ScheduleOptions } from '../src/server/jobs'
import { afterEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { parse, stringify } from 'devalue'
import { Elysia } from 'elysia'
import { cached } from '../src/runtime/cache'
import { jobRuns, queueRuns } from '../src/runtime/counters'
import { localeState, runInLocale } from '../src/runtime/locale-state'
import { previewState } from '../src/runtime/preview'
import { currentServerScope } from '../src/runtime/reactive'
import { withQuery } from '../src/runtime/with-query'
import { memoryJobs, queue, retryLater, schedule, shutdown, workflow } from '../src/server'
import { followsCaches, inLiveReads } from '../src/server/live'
import { answeringRequest } from '../src/server/log'
import { inPreview } from '../src/server/preview'
import { forgetQueue } from '../src/server/queue'
import { useAppOnError } from '../src/server/report'
import { inLoad, inServerScope } from '../src/server/scope'

let names = 0
const named = (kind: string) => `${kind}-hooks-${++names}`

async function until(condition: () => boolean): Promise<void> {
  for (const start = Date.now(); !condition(); await Bun.sleep(20)) {
    if (Date.now() - start > 5000)
      throw new Error('timed out')
  }
}

const quiet = () => [spyOn(console, 'error').mockImplementation(() => undefined), spyOn(console, 'warn').mockImplementation(() => undefined)] as const

afterEach(() => {
  setSystemTime()
  useAppOnError(undefined)
})

interface Reported { source: string | undefined, message: string }

function collect(): Reported[] {
  const reported: Reported[] = []

  useAppOnError(({ error, source }) => void reported.push({ source, message: (error as Error).message }))

  return reported
}

describe('a queue\'s run hooks', () => {
  it('tells onStart and onSuccess around a run, with the job, its payload and its attempt', async () => {
    const seen: unknown[] = []
    const name = named('queue')
    const jobs = queue<number>(name, (n: number) => void seen.push(['run', n]), {
      store: memoryJobs(),
      onStart: ({ id, payload, attempts, context }) => void seen.push(['start', typeof id, payload, attempts, context.request]),
      onSuccess: ({ payload, attempts }) => void seen.push(['success', payload, attempts]),
    })

    try {
      await jobs.enqueue(7)
      await jobs.drain()
      expect(seen).toEqual([['start', 'string', 7, 1, undefined], ['run', 7], ['success', 7, 1]])
      expect(queueRuns.get(name)).toEqual({ ok: 1, retried: 0, failed: 0 })
    }
    finally {
      forgetQueue(jobs)
    }
  })

  it('tells onRetry for each failed attempt that will run again, and onError once for the last, with the attempts counted', async () => {
    const [logged, warned] = quiet()
    const seen: unknown[] = []
    const name = named('queue')
    const jobs = queue<string>(name, () => {
      throw new Error('down')
    }, {
      store: memoryJobs(),
      attempts: 3,
      backoff: '10s',
      onStart: ({ attempts }) => void seen.push(['start', attempts]),
      onRetry: ({ attempts, error, wait }) => void seen.push(['retry', attempts, (error as Error).message, wait]),
      onError: ({ payload, attempts, error }) => void seen.push(['error', payload, attempts, (error as Error).message]),
      onSuccess: () => void seen.push('success'),
    })

    try {
      await jobs.enqueue('a')
      await jobs.drain()
      setSystemTime(Date.now() + 11_000)
      await jobs.drain()
      setSystemTime(Date.now() + 21_000)
      await jobs.drain()

      expect(seen).toEqual([['start', 1], ['retry', 1, 'down', 10_000], ['start', 2], ['retry', 2, 'down', 20_000], ['start', 3], ['error', 'a', 3, 'down']])
      expect(queueRuns.get(name)).toEqual({ ok: 0, retried: 2, failed: 1 })
    }
    finally {
      forgetQueue(jobs)
      logged.mockRestore()
      warned.mockRestore()
    }
  })

  it('tells onSuccess once for a job that fails then succeeds, and never onError', async () => {
    const warned = quiet()
    const seen: unknown[] = []
    let calls = 0
    const jobs = queue<undefined>(named('queue'), () => {
      if (++calls === 1)
        throw new Error('first')
    }, {
      store: memoryJobs(),
      backoff: '10s',
      onRetry: ({ attempts }) => void seen.push(['retry', attempts]),
      onSuccess: ({ attempts }) => void seen.push(['success', attempts]),
      onError: () => void seen.push('error'),
    })

    try {
      await jobs.enqueue(undefined)
      await jobs.drain()
      setSystemTime(Date.now() + 11_000)
      await jobs.drain()
      expect(seen).toEqual([['retry', 1], ['success', 2]])
    }
    finally {
      forgetQueue(jobs)

      for (const spy of warned)
        spy.mockRestore()
    }
  })

  it('tells none of onRetry and onError for a run that asks to run again with retryLater, nor onSuccess', async () => {
    const seen: string[] = []
    const jobs = queue<undefined>(named('queue'), () => {
      throw retryLater('1m')
    }, { store: memoryJobs(), onRetry: () => void seen.push('retry'), onError: () => void seen.push('error'), onSuccess: () => void seen.push('success') })
    const info = spyOn(console, 'info').mockImplementation(() => undefined)

    try {
      await jobs.enqueue(undefined)
      await jobs.drain()
      expect(seen).toEqual([])
    }
    finally {
      forgetQueue(jobs)
      info.mockRestore()
    }
  })

  it('logs a hook that throws, hands it to the app\'s onError with its source, and still runs the job and the next hook', async () => {
    const [logged] = quiet()
    const reported = collect()
    const seen: string[] = []
    const jobs = queue<undefined>(named('queue'), () => void seen.push('run'), {
      store: memoryJobs(),
      onStart: () => {
        throw new Error('start hook broke')
      },
      onSuccess: () => {
        throw new Error('success hook broke')
      },
    })

    try {
      await jobs.enqueue(undefined)
      expect(await jobs.drain()).toBe(1)
      expect(seen).toEqual(['run'])
      expect(reported).toEqual([{ source: 'queue.onStart', message: 'start hook broke' }, { source: 'queue.onSuccess', message: 'success hook broke' }])
      expect(await jobs.failed()).toEqual([])
    }
    finally {
      forgetQueue(jobs)
      logged.mockRestore()
    }
  })

  it('does not fail a job whose onError hook throws, and reports it as queue.onError', async () => {
    const [logged] = quiet()
    const reported = collect()
    const jobs = queue<undefined>(named('queue'), () => {
      throw new Error('boom')
    }, {
      store: memoryJobs(),
      attempts: 1,
      onError: () => {
        throw new Error('hook broke')
      },
    })

    try {
      await jobs.enqueue(undefined)
      await jobs.drain()
      expect(reported).toEqual([{ source: undefined, message: 'boom' }, { source: 'queue.onError', message: 'hook broke' }])
      expect(await jobs.failed()).toHaveLength(1)
    }
    finally {
      forgetQueue(jobs)
      logged.mockRestore()
    }
  })

  it('waits for a slow hook before the job runs, up to the 10 s cap, then leaves it running', async () => {
    const [logged] = quiet()
    const reported = collect()
    const seen: string[] = []
    let finish!: () => void
    const jobs = queue<undefined>(named('queue'), () => void seen.push('run'), {
      store: memoryJobs(),
      onStart: async () => new Promise<void>((resolve) => {
        finish = resolve
      }),
    })

    try {
      await jobs.enqueue(undefined)

      const drained = jobs.drain()

      await Bun.sleep(30)
      expect(seen).toEqual([])
      expect(await drained).toBe(1)
      expect(seen).toEqual(['run'])
      expect(reported.map(report => report.source)).toEqual(['queue.onStart'])
      finish()
    }
    finally {
      forgetQueue(jobs)
      logged.mockRestore()
    }
  }, 15_000)

  it('counts a run kept as failed once it was taken too often without ending, and tells onError', async () => {
    const [logged] = quiet()
    const seen: unknown[] = []
    const store = memoryJobs()
    const name = named('queue')
    const jobs = queue<undefined>(name, () => undefined, { store, attempts: 1, onError: ({ attempts, error }) => void seen.push([attempts, (error as Error).message]) })

    try {
      await jobs.enqueue(undefined)
      // A run whose process died took the claim and never marked how it went.
      await store.claim(name, Date.now(), Date.now() + 1)
      await Bun.sleep(5)
      await jobs.drain()
      expect(seen).toEqual([[1, expect.stringContaining('never finishing')]])
    }
    finally {
      forgetQueue(jobs)
      logged.mockRestore()
    }
  })
})

describe('a queue\'s hook context', () => {
  it('holds no request in a job, though a visitor\'s request woke the lazy queue\'s workers', async () => {
    const seen: unknown[] = []
    const jobs = queue<number>(named('queue'), () => undefined, {
      store: memoryJobs(),
      lazy: true,
      onStart: ({ context }) => void seen.push(['start', context.request, context.ip, context.userId, context.locale]),
      onSuccess: ({ context }) => void seen.push(['success', context.request]),
    })
    const app = new Elysia().use(jobs).listen(0)

    try {
      await answeringRequest(new Request('http://x/first-visitor'), async () => jobs.enqueue(1))
      await until(() => seen.length >= 2)
      await jobs.enqueue(2)
      await until(() => seen.length >= 4)
      expect(seen).toEqual([['start', undefined, undefined, undefined, undefined], ['success', undefined], ['start', undefined, undefined, undefined, undefined], ['success', undefined]])
    }
    finally {
      await shutdown(app)
      forgetQueue(jobs)
    }
  })

  it('shows a job\'s handler and hooks no request state, whichever request woke the lazy queue\'s workers', async () => {
    const seen: unknown[] = []
    const read = (where: string) => {
      let url: string | undefined

      try {
        url = withQuery({})
      }
      catch {
        url = undefined
      }

      seen.push([where, currentServerScope()?.request?.url, localeState() === undefined, previewState() === undefined, url, followsCaches()])
    }
    const jobs = queue<number>(named('queue'), () => read('run'), { store: memoryJobs(), lazy: true, onStart: () => read('start'), onSuccess: () => read('success') })
    const app = new Elysia().use(jobs).listen(0)
    const request = new Request('http://x/first-visitor?q=1')

    try {
      await answeringRequest(request, async () => inServerScope(request, () => undefined, async () => runInLocale({ locale: 'fr' } as never, async () => inLoad(new URL(request.url), async () => inPreview(async () => inLiveReads(async () => {
        await cached('wakes-the-queue', '1m', () => 1, { live: true })

        return jobs.enqueue(1)
      }, request))))))
      await until(() => seen.length >= 3)
      await jobs.enqueue(2)
      await until(() => seen.length >= 6)

      for (const [where, url, noLocale, noPreview, loaded, reads] of seen as [string, unknown, boolean, boolean, unknown, boolean][])
        expect([where, url, noLocale, noPreview, loaded, reads]).toEqual([where, undefined, true, true, undefined, false])
    }
    finally {
      await shutdown(app)
      forgetQueue(jobs)
    }
  })

  it('counts a slow onStart against lostAfter, as the store\'s hold started at the claim', async () => {
    const seen: string[] = []
    const jobs = queue<undefined>(named('queue'), async () => {
      await Bun.sleep(100)
      seen.push('ran')
    }, {
      store: memoryJobs(),
      lostAfter: '300ms',
      attempts: 1,
      onStart: async () => Bun.sleep(400),
      onSuccess: () => void seen.push('success'),
      onError: () => void seen.push('error'),
    })

    try {
      await jobs.enqueue(undefined)
      await jobs.drain()
      expect(seen).toContain('error')
      expect(seen).not.toContain('success')
    }
    finally {
      forgetQueue(jobs)
    }
  })
})

describe('a workflow\'s run hooks', () => {
  it('tells onStart once with the run and its input, onSuccess when the flow ends, not for each wake', async () => {
    const seen: unknown[] = []
    const flow = workflow<{ to: string }>(named('flow'), async ({ step }) => {
      await step.run('one', () => undefined)
      await step.sleep('1h')
      await step.run('two', () => undefined)
    }, {
      store: memoryJobs(),
      onStart: ({ id, input }) => void seen.push(['start', typeof id, input]),
      onSuccess: ({ input }) => void seen.push(['success', input]),
    })

    try {
      await flow.start({ to: 'a' })
      await flow.drain()
      expect(seen).toEqual([['start', 'string', { to: 'a' }]])
      setSystemTime(Date.now() + 2 * 60 * 60_000)
      await flow.drain()
      expect(seen).toEqual([['start', 'string', { to: 'a' }], ['success', { to: 'a' }]])
    }
    finally {
      forgetQueue(flow)
    }
  })

  it('tells onStart once for a run whose first step is a sleep', async () => {
    const seen: string[] = []
    const flow = workflow<undefined>(named('flow'), async ({ step }) => {
      await step.sleep('1h')
    }, { store: memoryJobs(), onStart: () => void seen.push('start'), onSuccess: () => void seen.push('success') })

    try {
      await flow.start()
      await flow.drain()
      setSystemTime(Date.now() + 2 * 60 * 60_000)
      await flow.drain()
      expect(seen).toEqual(['start', 'success'])
    }
    finally {
      forgetQueue(flow)
    }
  })

  it('tells onRetry for a failed attempt and onError with the run id and input once the last one fails', async () => {
    const [logged, warned] = quiet()
    const seen: unknown[] = []
    const flow = workflow<number>(named('flow'), () => {
      throw new Error('flow down')
    }, {
      store: memoryJobs(),
      attempts: 2,
      backoff: '10s',
      onRetry: ({ input, attempts }) => void seen.push(['retry', input, attempts]),
      onError: ({ id, input, attempts, error }) => void seen.push(['error', typeof id, input, attempts, (error as Error).message]),
    })

    try {
      await flow.start(3)
      await flow.drain()
      setSystemTime(Date.now() + 11_000)
      await flow.drain()
      expect(seen).toEqual([['retry', 3, 1], ['error', 'string', 3, 2, 'flow down']])
    }
    finally {
      forgetQueue(flow)
      logged.mockRestore()
      warned.mockRestore()
    }
  })
})

describe('a workflow\'s started flag', () => {
  it('tells onStart once for a run that retries after a kept step', async () => {
    const [logged, warned] = quiet()
    const seen: unknown[] = []
    let failed = false
    const flow = workflow<undefined>(named('flow'), async ({ step }) => {
      await step.run('one', () => undefined)

      if (!failed) {
        failed = true

        throw new Error('once')
      }
    }, {
      store: memoryJobs(),
      backoff: '10s',
      onStart: () => void seen.push('start'),
      onRetry: ({ attempts }) => void seen.push(['retry', attempts]),
      onSuccess: () => void seen.push('success'),
    })

    try {
      await flow.start()
      await flow.drain()
      setSystemTime(Date.now() + 11_000)
      await flow.drain()
      expect(seen).toEqual(['start', ['retry', 1], 'success'])
    }
    finally {
      forgetQueue(flow)
      logged.mockRestore()
      warned.mockRestore()
    }
  })

  it('tells onStart once more for a run stored before the flag existed, and not again after', async () => {
    const seen: string[] = []
    const store = memoryJobs()
    const name = named('flow')
    const flow = workflow<undefined>(name, async ({ step }) => {
      await step.sleep('1h')
      await step.sleep('1h')
    }, { store, onStart: () => void seen.push('start') })

    try {
      const id = await flow.start()

      await flow.drain()
      expect(seen).toEqual(['start'])

      const found = await store.state!(`workflow:${name}`, { key: id }, Date.now())
      const old = parse(found!.payload) as Record<string, unknown>

      delete old.started
      expect(await store.update!(found!.id, { payload: stringify(old), runAt: found!.runAt }, { payload: found!.payload, now: Date.now() })).toBe(true)
      setSystemTime(Date.now() + 2 * 60 * 60_000)
      await flow.drain()
      expect(seen).toEqual(['start', 'start'])
      setSystemTime(Date.now() + 2 * 60 * 60_000)
      await flow.drain()
      expect(seen).toEqual(['start', 'start'])
    }
    finally {
      forgetQueue(flow)
    }
  })
})

describe('a schedule\'s run hooks', () => {
  async function runOnce(job: () => unknown, options: ScheduleOptions) {
    const fired: (() => unknown)[] = []
    const parse = Bun.cron.parse.bind(Bun.cron)
    const cron = spyOn(Bun, 'cron')

    cron.mockImplementation(((_: string, handler: () => unknown) => {
      fired.push(handler)

      return { stop: () => undefined }
    }) as unknown as typeof Bun.cron)
    Object.assign(Bun.cron, { parse })

    const app = new Elysia().use(schedule('21 * * * *', job, options)).listen(0)

    try {
      await Promise.all(fired.map(async handler => handler()))
    }
    finally {
      cron.mockRestore()
      await shutdown(app)
    }
  }

  it('tells onStart and onSuccess around a run that ends well', async () => {
    const seen: unknown[] = []

    await runOnce(() => void seen.push('run'), {
      onStart: ({ schedule: label, boot }) => void seen.push(['start', label, boot]),
      onSuccess: ({ schedule: label, duration }) => void seen.push(['success', label, typeof duration]),
      onError: () => void seen.push('error'),
    })
    expect(seen).toEqual([['start', '21 * * * *', false], 'run', ['success', '21 * * * *', 'number']])
    expect(jobRuns.get('21 * * * *')?.ok).toBe(1)
  })

  it('tells onStart and onError for a run that throws, and never onSuccess', async () => {
    const [logged] = quiet()
    const seen: unknown[] = []

    try {
      await runOnce(() => {
        throw new Error('feed down')
      }, {
        onStart: () => void seen.push('start'),
        onSuccess: () => void seen.push('success'),
        onError: ({ error }) => void seen.push(['error', (error as Error).message]),
      })
    }
    finally {
      logged.mockRestore()
    }

    expect(seen).toEqual(['start', ['error', 'feed down']])
  })

  it('keeps a throwing hook from failing the run, reporting it with its source', async () => {
    const [logged] = quiet()
    const reported = collect()
    const seen: string[] = []

    try {
      await runOnce(() => void seen.push('run'), {
        onStart: () => {
          throw new Error('hook broke')
        },
      })
    }
    finally {
      logged.mockRestore()
    }

    expect(seen).toEqual(['run'])
    expect(reported).toEqual([{ source: 'schedule.onStart', message: 'hook broke' }])
  })

  it('tells onStart for a boot run, with boot true', async () => {
    const seen: unknown[] = []

    await runOnce(() => void seen.push('run'), { boot: true, onStart: ({ boot }) => void seen.push(['start', boot]), onSuccess: ({ boot }) => void seen.push(['success', boot]) })
    // The harness then fires the schedule once more, not as a boot run.
    expect(seen.slice(0, 3)).toEqual([['start', true], 'run', ['success', true]])
  })

  it('tells onError once for a run past its timeout, and onSuccess never', async () => {
    const [logged] = quiet()
    const seen: unknown[] = []

    try {
      await runOnce(async () => new Promise(() => undefined), { timeout: '1s', onStart: () => void seen.push('start'), onSuccess: () => void seen.push('success'), onError: ({ error }) => void seen.push(['error', (error as Error).message]) })
    }
    finally {
      logged.mockRestore()
    }

    expect(seen).toEqual(['start', ['error', 'it ran past its timeout, 1 s']])
  })

  it('tells neither onSuccess nor onError for a run a stop cut short', async () => {
    const seen: string[] = []
    const fired: (() => unknown)[] = []
    const parseCron = Bun.cron.parse.bind(Bun.cron)
    const cron = spyOn(Bun, 'cron')

    cron.mockImplementation(((_: string, handler: () => unknown) => {
      fired.push(handler)

      return { stop: () => undefined }
    }) as unknown as typeof Bun.cron)
    Object.assign(Bun.cron, { parse: parseCron })

    const app = new Elysia().use(schedule('22 * * * *', async () => {
      seen.push('run')
      // Ignores the signal, so the stop's grace ends the run.
      await new Promise(() => undefined)
    }, { onStart: () => void seen.push('start'), onSuccess: () => void seen.push('success'), onError: () => void seen.push('error') })).listen(0)

    try {
      const running = Promise.all(fired.map(async handler => handler()))

      await until(() => seen.includes('run'))
      await shutdown(app)
      await running
      expect(seen).toEqual(['start', 'run'])
    }
    finally {
      cron.mockRestore()
    }
  })

  it('reports a lock store that throws and tells neither onStart nor onError', async () => {
    const [logged] = quiet()
    const reported = collect()
    const seen: string[] = []
    const store = { ...memoryJobs(), lock: () => {
      throw new Error('store down')
    } }

    try {
      await runOnce(() => void seen.push('run'), { lock: 'broken', store, onStart: () => void seen.push('start'), onError: () => void seen.push('error') })
    }
    finally {
      logged.mockRestore()
    }

    expect(seen).toEqual([])
    expect(reported.map(report => report.message)).toEqual(['store down'])
  })

  it('tells no hook of a run another process took the lock of', async () => {
    const seen: string[] = []
    const store = memoryJobs()

    await store.lock('held', Math.round(Date.now() / 60_000))
    await runOnce(() => void seen.push('run'), { lock: 'held', store, onStart: () => void seen.push('start'), onSuccess: () => void seen.push('success') })
    expect(seen).toEqual([])
  })
})

describe('the clean context', () => {
  it('is loaded with the server, so the first request is not carried into a worker', async () => {
    const dir = import.meta.dir.replace(/\/tests$/, '')
    const script = `
      import { currentServerScope } from '${dir}/src/runtime/reactive'
      import '${dir}/src/server'
      import { inServerScope } from '${dir}/src/server/scope'
      await inServerScope(new Request('http://localhost/'), () => undefined, async () => {
        const { outsideRequest } = await import('${dir}/src/server/clean-context')
        console.log(outsideRequest(() => currentServerScope() === undefined))
      })
    `
    const run = Bun.spawnSync([process.execPath, '-e', script], { stderr: 'pipe' })

    expect(run.stdout.toString().trim()).toBe('true')
  })
})
