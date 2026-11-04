import { describe, expect, it } from 'bun:test'
import { stringify } from 'devalue'
import { Deadline, requestSignal, RequestTimeout, withTimeout } from '../src/server/request-timeout'
import { seen } from './fixtures/timeouts/src/seen'
import { pages } from './shared-pages'

const ROOT = 'tests/fixtures/timeouts'
const reported: unknown[] = []

const app = await pages({ root: ROOT, prebuilt: false, security: false, serve: { timeout: '100ms' }, observe: { onError: ({ error }) => void reported.push(error) } })
// No timeout of the app's: only what a page, an action and a route set for themselves holds.
const open = await pages({ root: ROOT, prebuilt: false, security: false })

const page = async (site: typeof app, path: string, accept = 'text/html') => site.handle(new Request(`http://localhost${path}`, { headers: { accept } }))

async function call(site: typeof app, name: string) {
  const url = `http://localhost/_kay/action/src/routes/act.kay/${name}`

  return site.handle(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1' }, body: stringify(undefined) }))
}

describe('request timeout', () => {
  it('answers a page past serve.timeout 504 through _error.kay, reports it and aborts ctx.signal', async () => {
    reported.length = 0

    const response = await page(app, '/slow')

    expect(response.status).toBe(504)
    expect(await response.text()).toContain('<h1>Error 504</h1>')
    expect(reported.at(0)).toBeInstanceOf(RequestTimeout)
    expect(seen.page?.aborted).toBe(true)
    expect(seen.page?.reason).toBeInstanceOf(RequestTimeout)
  })

  it('answers a request that is not for a page with plain text', async () => {
    const response = await page(app, '/slow', 'application/json')

    expect([response.status, await response.text()]).toEqual([504, 'Gateway Timeout'])
  })

  it('leaves a quick page and an app without a timeout alone', async () => {
    expect((await page(app, '/')).status).toBe(200)
    expect((await page(open, '/lenient')).status).toBe(200)
  })

  it('lets a page set its own, longer, shorter or none', async () => {
    expect((await page(app, '/lenient')).status).toBe(200)
    expect((await page(open, '/strict')).status).toBe(504)
  })

  it('cuts the body of a streamed page whose headers went out', async () => {
    reported.length = 0

    const response = await page(app, '/streamed')

    expect(response.status).toBe(200)
    await expect(response.text()).rejects.toBeInstanceOf(RequestTimeout)
    expect(reported.at(0)).toBeInstanceOf(RequestTimeout)
  })

  it('answers an action 504 as a failed call, with ctx.signal aborted', async () => {
    reported.length = 0

    const response = await call(app, 'slow')

    expect(response.status).toBe(504)
    expect(seen.action?.aborted).toBe(true)
    expect(reported.at(0)).toBeInstanceOf(RequestTimeout)
  })

  it('lets an action set its own timeout or none', async () => {
    expect((await call(app, 'patient')).status).toBe(200)
    expect((await call(open, 'strict')).status).toBe(504)
    expect((await call(open, 'patient')).status).toBe(200)
  })

  it('times an endpoint, ctx.signal included', async () => {
    const response = await page(app, '/feed.txt', 'text/plain')

    expect(response.status).toBe(504)
    expect(seen.endpoint?.aborted).toBe(true)
  })

  it('times an api() route, request.signal included, and honours the module and route settings', async () => {
    const get = async (site: typeof app, path: string) => site.handle(new Request(`http://localhost/api${path}`))

    expect((await get(app, '/slow')).status).toBe(504)
    expect(seen.api?.aborted).toBe(true)
    expect((await get(app, '/free')).status).toBe(200)
    expect((await get(open, '/own')).status).toBe(504)
    expect((await get(open, '/own/long')).status).toBe(200)
    expect((await get(open, '/slow')).status).toBe(200)
  })
})

describe('Deadline', () => {
  it('rejects with a RequestTimeout and aborts the signal when the time is up', async () => {
    const request = new Request('http://localhost/')
    const signal = requestSignal(request)

    await expect(withTimeout(request, 20, undefined, async () => Bun.sleep(200))).rejects.toBeInstanceOf(RequestTimeout)
    expect(signal.aborted).toBe(true)
  })

  it('aborts the signal when the client leaves', () => {
    const controller = new AbortController()
    const request = new Request('http://localhost/', { signal: controller.signal })
    const signal = requestSignal(request)

    controller.abort()
    expect(signal.aborted).toBe(true)
  })

  it('counts from the arrival, so a later start keeps what already passed', async () => {
    const deadline = new Deadline()

    await Bun.sleep(30)
    deadline.arm(40)
    await expect(deadline.expiry.promise).rejects.toBeInstanceOf(RequestTimeout)
  })

  it('runs work with no timeout as it is', async () => {
    expect(await withTimeout(new Request('http://localhost/'), undefined, undefined, async () => 'done')).toBe('done')
    expect(await withTimeout(new Request('http://localhost/'), false, 10, async () => {
      await Bun.sleep(30)

      return 'slow'
    })).toBe('slow')
  })
})
