import { describe, expect, it } from 'bun:test'
import { fakeService } from '../src/test'

const forgejo = fakeService({
  'GET /repos': ({ query }) => [{ page: query.get('page') }],
  'POST /repos': ({ json }) => ({ created: json() }),
  '/health': 'ok',
  '/empty': undefined,
  '/raw': () => new Response('teapot', { status: 418 }),
  '/static': new Response('same'),
  'get /lower': 'lower',
  'GET /nothing': undefined,
  '/boom': () => {
    throw new Error('route broke')
  },
})
const other = fakeService({ '/health': 'other' })

// Whether the request got an answer, false when it failed or was aborted.
async function reachable(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await fetch(url, { signal: signal ?? null })

    return true
  }
  catch {
    return false
  }
}

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

  it('reads a posted body, as text and as bytes', async () => {
    const answer = await fetch(`${forgejo.url}/repos`, { method: 'POST', body: JSON.stringify({ name: 'kay' }) })

    expect(await answer.json()).toEqual({ created: { name: 'kay' } })
    expect(forgejo.requests[0]?.json()).toEqual({ name: 'kay' })
    expect(forgejo.requests[0]?.bytes.length).toBe(forgejo.requests[0]?.text.length ?? -1)
  })

  it('records the bytes of an upload that is no text', async () => {
    const bytes = new Uint8Array([0, 255, 128, 7])

    await fetch(`${forgejo.url}/repos`, { method: 'POST', body: bytes })
    expect(forgejo.requests[0]?.bytes).toEqual(bytes)
  })

  it('answers text, nothing, a Response, and 404 for the rest, recording each', async () => {
    expect(await (await fetch(`${forgejo.url}/health`)).text()).toBe('ok')
    expect((await fetch(`${forgejo.url}/empty`)).status).toBe(204)
    expect((await fetch(`${forgejo.url}/raw`)).status).toBe(418)
    expect((await fetch(`${forgejo.url}/nowhere`)).status).toBe(404)
    expect((await fetch(`${forgejo.url}/repos`, { method: 'DELETE' })).status).toBe(404)
    expect(forgejo.requests.map(request => request.path)).toEqual(['/health', '/empty', '/raw', '/nowhere', '/repos'])
  })

  it('serves a static Response route on every request', async () => {
    expect(await (await fetch(`${forgejo.url}/static`)).text()).toBe('same')
    expect(await (await fetch(`${forgejo.url}/static`)).text()).toBe('same')
  })

  it('reads a method key in any case, and a route set to undefined is found', async () => {
    expect(await (await fetch(`${forgejo.url}/lower`)).text()).toBe('lower')
    expect((await fetch(`${forgejo.url}/nothing`)).status).toBe(204)
  })

  it('answers 500 for a route that throws and keeps the error', async () => {
    expect((await fetch(`${forgejo.url}/boom`)).status).toBe(500)
    expect((forgejo.errors[0] as Error).message).toBe('route broke')
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

    expect(await reachable(`${forgejo.url}/health`, AbortSignal.timeout(100))).toBe(false)
    expect(forgejo.requests).toHaveLength(1)
  })

  it('releases a stalled handler when the client aborts', async () => {
    forgejo.stall()

    const controller = new AbortController()
    const pending = reachable(`${forgejo.url}/health`, controller.signal)

    await Bun.sleep(30)
    controller.abort()
    expect(await pending).toBe(false)
  })

  it('takes a bare handler for every request', async () => {
    await using any = fakeService(({ path }) => ({ path }))

    expect(await (await fetch(`${any.url}/a/b`)).json()).toEqual({ path: '/a/b' })
  })

  it('keeps two fakes of a file apart', async () => {
    expect(await (await fetch(`${other.url}/health`)).text()).toBe('other')
    expect(other.requests).toHaveLength(1)
    expect(forgejo.requests).toHaveLength(0)
    expect(other.url).not.toBe(forgejo.url)
  })

  it('frees the port with stop() and with await using', async () => {
    const stopped = fakeService({ '/x': 'x' })

    expect(await reachable(`${stopped.url}/x`)).toBe(true)
    await stopped.stop()
    expect(await reachable(`${stopped.url}/x`)).toBe(false)

    let used = ''

    {
      await using scoped = fakeService({ '/x': 'x' })

      used = scoped.url
      expect(await reachable(`${used}/x`)).toBe(true)
    }

    expect(await reachable(`${used}/x`)).toBe(false)
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
