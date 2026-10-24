import type { Guard } from '../src/runtime'
import { join } from 'node:path'
import { describe, expect, it, spyOn } from 'bun:test'
import { queue, workflow } from '../src/server'
import { jobOverview } from '../src/server/job-admin'
import { memoryJobs } from '../src/server/queue'
import { cleanUpAfterFile } from './job-stores'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

cleanUpAfterFile()
spyOn(console, 'error').mockImplementation(() => undefined)
spyOn(console, 'warn').mockImplementation(() => undefined)

const allow: Guard = () => undefined
const admin: Guard = ({ request, deny }) => {
  if (request.headers.get('x-admin') !== 'yes')
    deny(403, 'admins only')
}

const toLogin: Guard = ({ redirect }) => redirect('/login')

let counter = 0

async function app(options: { jobs?: unknown, dev?: boolean, base?: string } = {}) {
  const dir = await scratchDir('jobs-page-')

  await Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n')

  return pages({ root: dir, routes: 'routes', prebuilt: false, security: false, dev: false, ...options } as Parameters<typeof pages>[0])
}

const get = async (site: Awaited<ReturnType<typeof app>>, path: string, headers: Record<string, string> = {}) => site.handle(new Request(`http://localhost${path}`, { headers }))
const post = async (site: Awaited<ReturnType<typeof app>>, path: string, body: Record<string, string>, headers: Record<string, string> = {}) => site.handle(new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body) }))

// A queue whose only job failed.
async function failedJob(label: string, payload = { n: 1 }) {
  const state = { broken: true }
  const jobs = queue<{ n: number }>(`page-${label}-${++counter}`, () => {
    if (state.broken)
      throw new Error('boom <b>')
  }, { store: memoryJobs(), attempts: 1 })
  const id = await jobs.enqueue(payload)

  await jobs.drain()

  return { jobs, id, state, name: `page-${label}-${counter}` }
}

describe('the production jobs page', () => {
  it('is not mounted unless the setting is there', async () => {
    expect((await get(await app(), '/_kay/jobs')).status).toBe(404)
  })

  it('refuses to boot without a guard', async () => {
    await expect(app({ jobs: {} })).rejects.toThrow('guard')
    await expect(app({ jobs: true })).rejects.toThrow('guard')
    await expect(app({ jobs: { guard: [] } })).rejects.toThrow('guard')
    await expect(app({ jobs: { guard: 'admin' } })).rejects.toThrow('guard')
  })

  it('is not mounted under kay dev', async () => {
    expect((await get(await app({ dev: true, jobs: { guard: allow } }), '/_kay/jobs')).status).toBe(404)
  })

  it('answers what the guard answers, for the page and both actions', async () => {
    const site = await app({ jobs: { guard: admin } })
    const { name, id } = await failedJob('guarded')

    expect(await (await get(site, '/_kay/jobs')).text()).toBe('admins only')
    expect((await get(site, '/_kay/jobs')).status).toBe(403)
    expect((await post(site, '/_kay/jobs/retry', { queue: name, id })).status).toBe(403)
    expect((await post(site, '/_kay/jobs/delete', { queue: name, id })).status).toBe(403)
  })

  it('follows a guard that redirects', async () => {
    const response = await get(await app({ jobs: { guard: toLogin } }), '/_kay/jobs')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login')
  })

  it('runs every guard of a list, the first refusal answering', async () => {
    const site = await app({ jobs: { guard: [allow, admin] } })

    expect((await get(site, '/_kay/jobs')).status).toBe(403)
    expect((await get(site, '/_kay/jobs', { 'x-admin': 'yes' })).status).toBe(200)
  })

  it('lists a failed job with its escaped error, uncached and not indexed', async () => {
    const site = await app({ jobs: { guard: allow } })
    const { name, id } = await failedJob('list')
    const response = await get(site, '/_kay/jobs')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
    expect(html).toContain(name)
    expect(html).toContain(id)
    expect(html).toContain('boom &lt;b&gt;')
    expect(html).not.toContain('boom <b>')
    expect(html).not.toContain('<script')
  })

  it('shows a due time outside the range of a date as it is', async () => {
    const site = await app({ jobs: { guard: allow } })
    const store = memoryJobs()
    const jobs = queue<{ n: number }>(`page-range-${++counter}`, () => undefined, { store })

    await store.add({ id: 'far', queue: `page-range-${counter}`, payload: '1', attempts: 0, runAt: 1e18 })

    const response = await get(site, '/_kay/jobs')

    expect(response.status).toBe(200)
    expect(await response.text()).toContain(String(1e18))
    expect(jobs).toBeDefined()
  })

  it('retries and deletes a job, then goes back to the page', async () => {
    const site = await app({ jobs: { guard: allow }, base: '/shop' })
    const { name, id, state, jobs } = await failedJob('act')

    state.broken = false

    const retried = await post(site, '/_kay/jobs/retry', { queue: name, id })

    expect(retried.status).toBe(303)
    expect(retried.headers.get('location')).toBe('/shop/_kay/jobs')
    expect(await (await get(site, '/_kay/jobs')).text()).toContain('waiting')
    await jobs.drain()
    expect(await (await get(site, '/_kay/jobs')).text()).not.toContain(id)

    const second = await failedJob('act-delete')
    const baseDelete = await post(site, '/_kay/jobs/delete', { queue: second.name, id: second.id })

    expect(baseDelete.status).toBe(303)
    expect(baseDelete.headers.get('location')).toBe('/shop/_kay/jobs')
    expect(await (await get(site, '/_kay/jobs')).text()).not.toContain(second.id)
  })

  it('names the form actions under the base', async () => {
    const site = await app({ jobs: { guard: allow }, base: '/shop' })

    await failedJob('base')
    expect(await (await get(site, '/_kay/jobs')).text()).toContain('action="/shop/_kay/jobs/retry"')
  })

  it('refuses a post from another site and one that names no job', async () => {
    const site = await app({ jobs: { guard: allow } })
    const { name, id } = await failedJob('cross')

    expect((await post(site, '/_kay/jobs/delete', { queue: name, id }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post(site, '/_kay/jobs/delete', { queue: name, id }, { origin: 'http://evil.example' })).status).toBe(403)
    expect(await (await get(site, '/_kay/jobs')).text()).toContain(id)
    expect((await post(site, '/_kay/jobs/delete', { queue: name, id: 'nope' })).status).toBe(404)
    expect((await post(site, '/_kay/jobs/delete', {})).status).toBe(400)
  })

  it('moves with path', async () => {
    const site = await app({ jobs: { guard: allow, path: '/ops/jobs' } })

    expect((await get(site, '/ops/jobs')).status).toBe(200)
    expect((await get(site, '/_kay/jobs')).status).toBe(404)
  })

  it('says so when the app has no queue', async () => {
    const site = await app({ jobs: { guard: allow } })

    expect((await get(site, '/_kay/jobs')).status).toBe(200)
  })
})

// The one job of a workflow's queue.
async function runOf(name: string) {
  const queues = await jobOverview()

  return queues.find(queued => queued.name === `workflow:${name}`)!.jobs[0]!
}

describe('the production jobs page for a workflow run', () => {
  it('shows its state and steps without script, sends its event and cancels it', async () => {
    const site = await app({ jobs: { guard: allow } })
    const name = `page-flow-${++counter}`
    const flow = workflow<undefined, { paid: number }>(name, async ({ step }) => {
      await step.run('charge <b>', () => 1)
      await step.waitFor('paid')
    }, { store: memoryJobs() })
    const id = await flow.start(undefined, { id: 'order-1' })

    await flow.drain()

    const html = await (await get(site, '/_kay/jobs')).text()

    expect(html).toContain('<strong>waiting</strong>')
    expect(html).toContain('workflow run waiting for event <code>paid</code>, 1 steps done: <code>run charge &lt;b&gt;</code>')
    expect(html).not.toContain('<script')
    expect(html).toContain('action="/_kay/jobs/send"')
    expect(html).toContain('Cancel')

    const job = await runOf(name)
    const sent = await post(site, '/_kay/jobs/send', { queue: `workflow:${name}`, id: job.id })

    expect(sent.status).toBe(303)
    await flow.drain()
    expect(await flow.status(id)).toBeUndefined()

    const second = await flow.start(undefined, { id: 'order-2' })

    await flow.drain()

    const again = await runOf(name)

    expect((await post(site, '/_kay/jobs/cancel', { queue: `workflow:${name}`, id: again.id })).status).toBe(303)
    expect(await flow.status(second)).toBeUndefined()
    expect((await post(site, '/_kay/jobs/send', { queue: `workflow:${name}`, id: again.id })).status).toBe(404)
  })
})
