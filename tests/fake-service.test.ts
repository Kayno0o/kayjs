import { describe, expect, it } from 'bun:test'
import { fakeService } from '../src/test'

const forgejo = fakeService({
  'GET /repos': ({ query }) => [{ page: query.get('page') }],
  'POST /repos': ({ json }) => ({ created: json() }),
  '/health': 'ok',
  '/empty': undefined,
  '/raw': () => new Response('teapot', { status: 418 }),
})

describe('fakeService', () => {
  it('answers a route by method and path, and records the request', async () => {
    const answer = await fetch(`${forgejo.url}/repos?page=2`, { headers: { authorization: 'token t' } })

    expect(await answer.json()).toEqual([{ page: '2' }])
    expect(forgejo.requests).toHaveLength(1)
    expect(forgejo.requests[0]?.headers.get('authorization')).toBe('token t')
    expect(forgejo.requests[0]?.query.get('page')).toBe('2')
  })

  it('clears the requests with each test', () => {
    expect(forgejo.requests).toHaveLength(0)
  })

  it('reads a posted body', async () => {
    const answer = await fetch(`${forgejo.url}/repos`, { method: 'POST', body: JSON.stringify({ name: 'kay' }) })

    expect(await answer.json()).toEqual({ created: { name: 'kay' } })
    expect(forgejo.requests[0]?.json()).toEqual({ name: 'kay' })
  })

  it('answers text, nothing, a Response, and 404 for the rest, recording each', async () => {
    expect(await (await fetch(`${forgejo.url}/health`)).text()).toBe('ok')
    expect((await fetch(`${forgejo.url}/empty`)).status).toBe(204)
    expect((await fetch(`${forgejo.url}/raw`)).status).toBe(418)
    expect((await fetch(`${forgejo.url}/nowhere`)).status).toBe(404)
    expect((await fetch(`${forgejo.url}/repos`, { method: 'DELETE' })).status).toBe(404)
    expect(forgejo.requests.map(request => request.path)).toEqual(['/health', '/empty', '/raw', '/nowhere', '/repos'])
  })

  it('fails every request with a status until the test ends', async () => {
    forgejo.fail(503, 'down')

    const answer = await fetch(`${forgejo.url}/health`)

    expect(answer.status).toBe(503)
    expect(await answer.text()).toBe('down')
  })

  it('answers again once the failing test ended', async () => {
    expect((await fetch(`${forgejo.url}/health`)).status).toBe(200)
  })

  it('stalls until the client gives up', async () => {
    forgejo.stall()

    let aborted = false

    try {
      await fetch(`${forgejo.url}/health`, { signal: AbortSignal.timeout(100) })
    }
    catch {
      aborted = true
    }

    expect(aborted).toBe(true)
    expect(forgejo.requests).toHaveLength(1)
  })

  it('takes a bare handler for every request', async () => {
    await using any = fakeService(({ path }) => ({ path }))

    expect(await (await fetch(`${any.url}/a/b`)).json()).toEqual({ path: '/a/b' })
  })

  it('serves with a DOM registered over the web classes', async () => {
    const before = globalThis.Response

    globalThis.Response = class Other {} as unknown as typeof Response

    try {
      expect(await (await fetch(`${forgejo.url}/health`)).text()).toBe('ok')
    }
    finally {
      globalThis.Response = before
    }
  })
})
