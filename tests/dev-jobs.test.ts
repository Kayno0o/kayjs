import type { JobStore } from '../src/server'
import type { JobView, QueueView } from '../src/server/job-admin'
import { join } from 'node:path'
import { afterEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { queue, workflow } from '../src/server'
import { forgetQueue, GiveUpError } from '../src/server/queue'
import { cleanUpAfterFile, kinds } from './job-stores'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

cleanUpAfterFile()

// The failing handlers log each failure.
spyOn(console, 'error').mockImplementation(() => undefined)
spyOn(console, 'warn').mockImplementation(() => undefined)

const HEADERS = { 'x-kay-dev': '1' }

async function app(options: { dev: boolean, base?: string } = { dev: true }) {
  const dir = await scratchDir('dev-jobs-')

  await Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n')

  return pages({ root: dir, routes: 'routes', prebuilt: false, security: false, ...options })
}

type App = Awaited<ReturnType<typeof app>>

async function listed(site: App): Promise<QueueView[]> {
  return (await (await site.handle(new Request('http://localhost/_kay/dev/jobs', { headers: HEADERS }))).json() as { queues: QueueView[] }).queues
}

async function act(site: App, action: 'retry' | 'delete' | 'send' | 'cancel', queueName: string, id: string, headers: Record<string, string> = HEADERS) {
  return site.handle(new Request(`http://localhost/_kay/dev/jobs/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ queue: queueName, id }) }))
}

describe('the dev tool\'s jobs endpoints', () => {
  it('lists no queue for an app without one', async () => {
    expect(await listed(await app())).toEqual([])
  })

  it('answers nothing in a production server', async () => {
    const site = await app({ dev: false })

    expect((await site.handle(new Request('http://localhost/_kay/dev/jobs', { headers: HEADERS }))).status).toBe(404)
    expect((await act(site, 'retry', 'q', 'x')).status).toBe(404)
    expect((await act(site, 'delete', 'q', 'x')).status).toBe(404)
    expect((await site.handle(new Request('http://localhost/_kay/dev/tab/jobs.js', { headers: HEADERS }))).status).toBe(404)
  })

  it('refuses a request without the dev tool\'s header or from another site', async () => {
    const site = await app()

    expect((await site.handle(new Request('http://localhost/_kay/dev/jobs'))).status).toBe(403)
    expect((await act(site, 'delete', 'q', 'x', {})).status).toBe(403)
    for (const action of ['retry', 'delete'] as const) {
      expect((await act(site, action, 'q', 'x', { ...HEADERS, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
      expect((await act(site, action, 'q', 'x', { ...HEADERS, origin: 'https://evil.example' })).status).toBe(403)
    }

    expect((await site.handle(new Request('http://localhost/_kay/dev/jobs', { headers: { ...HEADERS, origin: 'https://evil.example' } }))).status).toBe(403)
  })

  it('serves the tab as browser code', async () => {
    const response = await (await app({ dev: true, base: '/shop' })).handle(new Request('http://localhost/_kay/dev/tab/jobs.js'))
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('export default')
    expect(text).not.toMatch(/^import /m)
  })
})

describe.each(kinds)('the Jobs tab\'s queues on a $name store', ({ name, open }) => {
  // A queue whose handler fails while `broken`, made with the store of the case.
  async function made(label: string, handler?: (payload: { n: number }, signal: AbortSignal) => unknown) {
    const state = { broken: true }
    const store = await open()
    const jobs = queue<{ n: number }>(`${name}-${label}`, handler ?? (() => {
      if (state.broken)
        throw new Error('boom')
    }), { store, attempts: 2, backoff: '1s' })

    return { jobs, state, store }
  }

  const find = (queues: QueueView[], label: string) => queues.find(queued => queued.name === `${name}-${label}`)!

  it('lists a queue\'s waiting job with its payload and attempts', async () => {
    const { jobs } = await made('waiting')
    const site = await app()

    await jobs.enqueue({ n: 1 }, { key: 'one', delay: '1h' })

    const view = find(await listed(site), 'waiting')

    expect(view).toMatchObject({ attempts: 2, listsJobs: true, canRetry: true, truncated: false })
    expect(view.jobs).toHaveLength(1)
    expect(view.jobs[0]).toMatchObject({ status: 'waiting', attempts: 0, key: 'one' })
    expect(view.jobs[0]!.payload).toContain('1')
  })

  it('lists a running job as running, refuses to delete or retry it, and a finished one is gone', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { jobs } = await made('running', async () => gate)
    const site = await app()
    const id = await jobs.enqueue({ n: 1 })
    const draining = jobs.drain()

    await Bun.sleep(50)

    const [running] = find(await listed(site), 'running').jobs as [JobView]

    expect(running).toMatchObject({ id, status: 'running', attempts: 1 })
    expect((await act(site, 'delete', `${name}-running`, id)).status).toBe(409)
    expect((await act(site, 'retry', `${name}-running`, id)).status).toBe(409)
    release()
    await draining
    expect(find(await listed(site), 'running').jobs).toEqual([])
  })

  it('lists a failed job with its error, retries it from its first attempt and runs it again', async () => {
    const { jobs, state } = await made('retry')
    const site = await app()
    const id = await jobs.enqueue({ n: 7 })

    await jobs.drain()
    await Bun.sleep(1100)
    await jobs.drain()

    const [failed] = find(await listed(site), 'retry').jobs as [JobView]

    expect(failed).toMatchObject({ id, status: 'failed', attempts: 2, error: expect.stringContaining('boom') })
    expect(failed.payload).toContain('7')

    state.broken = false

    const retried = await act(site, 'retry', `${name}-retry`, id)

    expect(retried.status).toBe(200)
    expect(find(await listed(site), 'retry').jobs[0]).toMatchObject({ id, status: 'waiting', attempts: 0 })
    expect((await act(site, 'retry', `${name}-retry`, id)).status).toBe(409)
    await jobs.drain()
    expect(find(await listed(site), 'retry').jobs).toEqual([])
  })

  it('deletes a failed job, and says so for one already gone, a queue it has not and a missing body', async () => {
    const { jobs } = await made('delete')
    const site = await app()
    const id = await jobs.enqueue({ n: 1 })

    await jobs.drain()
    await Bun.sleep(1100)
    await jobs.drain()
    expect(find(await listed(site), 'delete').jobs[0]).toMatchObject({ status: 'failed' })
    expect((await act(site, 'delete', `${name}-delete`, id)).status).toBe(200)
    expect(find(await listed(site), 'delete').jobs).toEqual([])
    expect((await act(site, 'delete', `${name}-delete`, id)).status).toBe(404)
    expect((await act(site, 'delete', 'no-such-queue', id)).status).toBe(404)
    expect((await site.handle(new Request('http://localhost/_kay/dev/jobs/delete', { method: 'POST', headers: { ...HEADERS, 'content-type': 'application/json' }, body: '{}' }))).status).toBe(400)
  })

  it('does not take a job of one queue for another\'s', async () => {
    const first = await made('first')
    const second = await made('second')
    const site = await app()
    const id = await first.jobs.enqueue({ n: 1 }, { delay: '1h' })

    await second.jobs.enqueue({ n: 2 }, { delay: '1h' })
    expect((await act(site, 'delete', `${name}-second`, id)).status).toBe(404)
    expect(find(await listed(site), 'first').jobs).toHaveLength(1)

    forgetQueue(first.jobs)
    forgetQueue(second.jobs)
  })
})

describe('a long queue', () => {
  it('reads a cap of jobs from the store, not every job of the queue', async () => {
    const memory = await kinds[0]!.open()
    const read = { jobs: 0, failed: 0 }
    const counting: JobStore = {
      ...memory,
      async jobs(name, options) {
        const found = await memory.jobs!(name, options)

        read.jobs = Math.max(read.jobs, found.length)

        return found
      },
      async failed(name, limit) {
        const found = await memory.failed(name, limit)

        read.failed = Math.max(read.failed, found.length)

        return found
      },
    }
    const queued = queue<{ n: number }>('long', () => {
      throw new Error('boom')
    }, { store: counting, attempts: 1 })
    const site = await app()

    for (let n = 0; n < 250; n++)
      await queued.enqueue({ n }, { delay: '1h' })

    const view = (await listed(site)).find(found => found.name === 'long')!

    expect(view.jobs).toHaveLength(100)
    expect(view.truncated).toBe(true)
    expect(read.jobs).toBeLessThanOrEqual(101)
    expect(read.failed).toBeLessThanOrEqual(101)
    forgetQueue(queued)
  })
})

describe('a queue renamed during kay dev', () => {
  it('leaves the tool when its module runs again', async () => {
    process.env.KAY_DEV_CODE = '1'

    try {
      const { queueAdmins } = await import('../src/server/queue')
      const { disposeOwned } = await import('../src/server/reload')
      const queued = queue<{ n: number }>('renamed-away', () => undefined, { store: await kinds[0]!.open() })

      expect(queueAdmins().some(admin => admin.name === 'renamed-away')).toBe(true)
      await disposeOwned(new Set([import.meta.path]))
      expect(queueAdmins().some(admin => admin.name === 'renamed-away')).toBe(false)
      forgetQueue(queued)
    }
    finally {
      delete process.env.KAY_DEV_CODE
    }
  })
})

describe('a queue on a store without revive or state', () => {
  it('shows its failed jobs and refuses a retry the store cannot do', async () => {
    const memory = (await kinds[0]!.open())
    const bare = Object.fromEntries(Object.entries(memory).filter(([key]) => !['revive', 'state', 'jobs'].includes(key))) as unknown as JobStore
    const queued = queue<{ n: number }>('bare', () => {
      throw new Error('boom')
    }, { store: bare, attempts: 1 })
    const site = await app()
    const id = await queued.enqueue({ n: 1 })

    await queued.drain()

    const view = (await listed(site)).find(found => found.name === 'bare')!

    expect(view).toMatchObject({ canRetry: false, listsJobs: false })
    expect(view.jobs).toMatchObject([{ id, status: 'failed' }])
    expect((await act(site, 'retry', 'bare', id)).status).toBe(409)
    forgetQueue(queued)
  })
})

describe.each(kinds)('the Jobs tab\'s workflow runs on a $name store', ({ name, open }) => {
  afterEach(() => {
    setSystemTime()
  })

  async function flowOf(label: string) {
    const queueName = `${name}-${label}`
    const flow = workflow<undefined, { paid: number }>(queueName, async ({ step }) => {
      await step.run('charge', () => 1)
      await step.sleep('1h')
      await step.waitFor('paid')
      await step.run('ship', () => 2)
    }, { store: await open() })

    return { flow, queueName: `workflow:${queueName}` }
  }

  it('shows a run sleeping, then waiting for an event with its steps, and sends the event', async () => {
    const { flow, queueName } = await flowOf('send')
    const site = await app()
    const id = await flow.start(undefined, { id: 'order-1' })

    await flow.drain()

    const [sleeping] = (await listed(site)).find(queued => queued.name === queueName)!.jobs as [JobView]

    expect(sleeping.workflow).toMatchObject({ state: 'sleeping', steps: ['run charge', 'sleep'] })
    expect(sleeping.workflow!.until).toBeGreaterThan(Date.now())
    setSystemTime(Date.now() + 2 * 3600_000)
    await flow.drain()

    const [waiting] = (await listed(site)).find(queued => queued.name === queueName)!.jobs as [JobView]

    expect(waiting.workflow).toMatchObject({ state: 'waiting', event: 'paid', steps: ['run charge', 'sleep'] })
    expect(waiting.workflow!.until).toBeUndefined()
    expect((await act(site, 'send', queueName, waiting.id)).status).toBe(200)
    await flow.drain()
    expect(await flow.status(id)).toBeUndefined()
  })

  it('cancels a run, and refuses to send an event to one that does not wait or to a plain queue', async () => {
    const { flow, queueName } = await flowOf('cancel')
    const site = await app()

    await flow.start()
    await flow.drain()

    const [run] = (await listed(site)).find(queued => queued.name === queueName)!.jobs as [JobView]

    expect((await act(site, 'send', queueName, run.id)).status).toBe(409)
    expect((await act(site, 'cancel', queueName, run.id)).status).toBe(200)
    expect((await act(site, 'cancel', queueName, run.id)).status).toBe(404)

    const plain = queue<{ n: number }>(`${name}-plain-wf`, () => undefined, { store: await open() })
    const plainId = await plain.enqueue({ n: 1 })

    expect((await act(site, 'cancel', `${name}-plain-wf`, plainId)).status).toBe(409)
    expect((await act(site, 'send', `${name}-plain-wf`, plainId)).status).toBe(409)
    expect((await act(site, 'send', 'nope', 'x')).status).toBe(404)
  })

  it('cancels the failed run of the row clicked, not a live run started under the same id', async () => {
    const queueName = `${name}-twin`
    const flow = workflow<boolean, Record<string, unknown>>(queueName, async ({ input, step }) => {
      if (input)
        throw new GiveUpError('boom')

      await step.sleep('1h')
    }, { store: await open(), attempts: 1 })
    const site = await app()
    const wf = `workflow:${queueName}`

    await flow.start(true, { id: 'twin' })
    await flow.drain()
    await flow.start(false, { id: 'twin' })
    await flow.drain()

    const jobs = (await listed(site)).find(queued => queued.name === wf)!.jobs
    const failed = jobs.find(job => job.status === 'failed')!

    expect(jobs).toHaveLength(2)
    expect((await act(site, 'cancel', wf, failed.id)).status).toBe(200)

    const left = (await listed(site)).find(queued => queued.name === wf)!.jobs

    expect(left.map(job => job.workflow?.state)).toEqual(['sleeping'])
  })

  it('lists the last steps of a long run, cut, with how many are kept', async () => {
    const queueName = `${name}-long`
    const flow = workflow<undefined, Record<string, unknown>>(queueName, async ({ step }) => {
      for (let index = 0; index < 30; index++)
        await step.run(`step ${index} ${'x'.repeat(300)}`, () => index)

      await step.sleep('1h')
    }, { store: await open() })
    const site = await app()

    await flow.start()
    await flow.drain()

    const [job] = (await listed(site)).find(queued => queued.name === `workflow:${queueName}`)!.jobs as [JobView]

    expect(job.workflow!.done).toBe(31)
    expect(job.workflow!.steps).toHaveLength(20)
    expect(job.workflow!.steps.at(-1)).toBe('sleep')
    expect(job.workflow!.steps.every(label => label.length <= 100)).toBe(true)
  })

  it('shows a malformed payload of a workflow-named queue as a plain job', async () => {
    const queueName = `${name}-odd`
    const odd = queue<{ memo: unknown[] }>(`workflow:${queueName}`, () => undefined, { store: await open() })

    await odd.enqueue({ memo: [1, null] }, { delay: '1h' })

    const [job] = (await listed(await app())).find(queued => queued.name === `workflow:${queueName}`)!.jobs as [JobView]

    expect(job.workflow).toBeUndefined()
  })
})
