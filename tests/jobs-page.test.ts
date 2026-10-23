import type { Guard } from '../src/runtime'
import { join } from 'node:path'
import { describe, expect, it, spyOn } from 'bun:test'
import { queue } from '../src/server'
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
