import type { GateDeps } from '../src/gate'
import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { createGate } from '../src/gate'

interface User { id: number }

const deps: GateDeps<User, string> = {
  principal: async ctx => ((ctx as { request: Request }).request.headers.get('authorization') === 'Bearer good' ? { id: 1 } : null),
  authorize: async (principal, requirement) =>
    (typeof requirement === 'function' ? Boolean(await requirement(principal, {})) : false),
  // Secure by default: any authenticated principal.
  defaultRequirement: p => p != null,
}

function buildApp() {
  return new Elysia()
    .use(createGate(deps))
    .get('/default', () => 'ok')
    .get('/open', () => 'ok', { auth: false })
    .get('/custom', () => 'ok', { auth: (p: User | null) => p?.id === 2 })
}

function req(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, { headers })
}

describe('createGate', () => {
  test('an unannotated route falls back to defaultRequirement and 401s when anonymous', async () => {
    const res = await buildApp().handle(req('/default'))

    expect(res.status).toBe(401)
  })

  test('an unannotated route passes for an authenticated principal', async () => {
    const res = await buildApp().handle(req('/default', { authorization: 'Bearer good' }))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  test('auth: false opts a route out entirely', async () => {
    const res = await buildApp().handle(req('/open'))

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  test('auth: <requirement> overrides the default and answers a signed-in denial with 403', async () => {
    const denied = await buildApp().handle(req('/custom', { authorization: 'Bearer good' }))

    // principal is { id: 1 }, requirement wants id === 2.
    expect(denied.status).toBe(403)
    expect(await denied.text()).toBe('Forbidden')
  })

  test('routes added through group, guard, route, all and a used plugin fall back to the default', async () => {
    const sub = new Elysia({ prefix: '/sub' }).get('/', () => 'ok')
    const app = new Elysia()
      .use(createGate(deps))
      .group('/g', g => g.get('/', () => 'ok').get('/open', () => 'ok', { auth: false }))
      .guard({}, g => g.get('/guard', () => 'ok'))
      .use(sub)
      .route('GET', '/route', () => 'ok')
      .all('/all', () => 'ok')

    for (const path of ['/g', '/guard', '/sub', '/route', '/all'])
      expect((await app.handle(req(path))).status).toBe(401)

    expect((await app.handle(req('/g', { authorization: 'Bearer good' }))).status).toBe(200)
    expect((await app.handle(req('/g/open'))).status).toBe(200)
  })

  test('a websocket route falls back to the default too, refusing the upgrade to an anonymous visitor', async () => {
    const app = new Elysia().use(createGate(deps)).ws('/socket', { message: () => undefined }).listen(0)
    const upgrade = { 'upgrade': 'websocket', 'connection': 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' }
    const status = async (headers: Record<string, string>) => (await fetch(`http://localhost:${app.server!.port}/socket`, { headers: { ...upgrade, ...headers } })).status

    try {
      expect([await status({}), await status({ authorization: 'Bearer good' })]).toEqual([401, 101])
    }
    finally {
      await app.stop()
    }
  })

  test('a route under two authed instances is authorized once', async () => {
    let calls = 0
    const counting = createGate<User, string>({
      ...deps,
      authorize: async (principal, requirement) => {
        calls++

        return deps.authorize(principal, requirement, 'read', {})
      },
    })
    const inner = new Elysia().use(counting).get('/inner', () => 'ok')
    const app = new Elysia().use(counting).use(inner)

    expect((await app.handle(req('/inner', { authorization: 'Bearer good' }))).status).toBe(200)
    expect(calls).toBe(1)
  })

  test('a looser outer gate does not let a route through a stricter inner one', async () => {
    const inner = new Elysia().use(createGate<User, string>({ ...deps, defaultRequirement: p => p?.id === 2 })).get('/admin', () => 'secret')
    const app = new Elysia().use(createGate(deps)).use(inner)

    expect((await app.handle(req('/admin'))).status).toBe(401)
    expect((await app.handle(req('/admin', { authorization: 'Bearer good' }))).status).toBe(403)
  })

  test('a parent that uses an authed plugin keeps its own later routes as they were', async () => {
    const authed = new Elysia().use(createGate(deps)).get('/authed', () => 'ok')
    const app = new Elysia().use(authed).get('/later', () => 'ok').use(new Elysia().get('/later-plugin', () => 'ok'))

    expect((await app.handle(req('/authed'))).status).toBe(401)
    expect((await app.handle(req('/later'))).status).toBe(200)
    expect((await app.handle(req('/later-plugin'))).status).toBe(200)
  })

  test('an authed route file mounted in a group leaves a sibling plugin without auth open', async () => {
    const authed = new Elysia().use(createGate(deps)).get('/', () => 'ok')
    const open = new Elysia().get('/', () => 'ok')
    const app = new Elysia()
      .group('/authed', a => a.use(authed))
      .group('/open', a => a.use(open))

    expect((await app.handle(req('/authed'))).status).toBe(401)
    expect((await app.handle(req('/open'))).status).toBe(200)
  })
})
