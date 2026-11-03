import type { ScheduleOptions } from '../src/server/jobs'
import { afterEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { jobRuns, queueRuns } from '../src/runtime/counters'
import { memoryJobs, queue, retryLater, schedule, shutdown, workflow } from '../src/server'
import { forgetQueue } from '../src/server/queue'
import { useAppOnError } from '../src/server/report'

let names = 0
const named = (kind: string) => `${kind}-hooks-${++names}`
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

  it('still reads onFailed, after onError, with the same payload and error', async () => {
    const [logged] = quiet()
    const seen: unknown[] = []
    const jobs = queue<number>(named('queue'), () => {
      throw new Error('gone')
    }, {
      store: memoryJobs(),
      attempts: 1,
      onError: ({ payload }) => void seen.push(['error', payload]),
      onFailed: ({ payload, error }) => void seen.push(['failed', payload, (error as Error).message]),
    })

    try {
      await jobs.enqueue(5)
      await jobs.drain()
      expect(seen).toEqual([['error', 5], ['failed', 5, 'gone']])
    }
    finally {
      forgetQueue(jobs)
      logged.mockRestore()
    }
  })

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

  it('tells onRetry for a failed attempt and onError with the run id and input once the last one fails, onFailed still read', async () => {
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
      onFailed: ({ input }) => void seen.push(['failed', input]),
    })

    try {
      await flow.start(3)
      await flow.drain()
      setSystemTime(Date.now() + 11_000)
      await flow.drain()
      expect(seen).toEqual([['retry', 3, 1], ['error', 'string', 3, 2, 'flow down'], ['failed', 3]])
    }
    finally {
      forgetQueue(flow)
      logged.mockRestore()
      warned.mockRestore()
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

  it('tells no hook of a run another process took the lock of', async () => {
    const seen: string[] = []
    const store = memoryJobs()

    await store.lock('held', Math.round(Date.now() / 60_000))
    await runOnce(() => void seen.push('run'), { lock: 'held', store, onStart: () => void seen.push('start'), onSuccess: () => void seen.push('success') })
    expect(seen).toEqual([])
  })
})
