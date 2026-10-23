import type { JobStore } from '../src/server'
import type { JobView, QueueView } from '../src/server/job-admin'
import { join } from 'node:path'
import { describe, expect, it, spyOn } from 'bun:test'
import { queue } from '../src/server'
import { forgetQueue } from '../src/server/queue'
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

async function act(site: App, action: 'retry' | 'delete', queueName: string, id: string, headers: Record<string, string> = HEADERS) {
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
