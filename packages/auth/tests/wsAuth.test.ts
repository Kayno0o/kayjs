import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { createWsAuthStore } from '../src/wsAuth'
import { testApp, userRecord } from './helpers/app'

describe('createWsAuthStore', () => {
  const ws = (id: string) => {
    const sent: string[] = []

    return { ws: { id, send: (m: string) => sent.push(m), close: () => undefined }, sent }
  }

  test('stores the verified value per connection and acks', async () => {
    const store = createWsAuthStore<{ userId: number }>(async token => token === 'good' ? { userId: 1 } : null)
    const a = ws('c1')

    await store.handleAuth(a.ws, 'good')

    expect(store.get(a.ws)).toEqual({ userId: 1 })
    expect(a.sent).toEqual([JSON.stringify({ type: 'authed' })])
  })

  test('a rejected token stores nothing and sends no ack', async () => {
    const store = createWsAuthStore<{ userId: number }>(async () => null)
    const a = ws('c2')

    await store.handleAuth(a.ws, 'bad')

    expect(store.get(a.ws)).toBeUndefined()
    expect(a.sent).toEqual([])
  })

  test('forget drops the stored value', async () => {
    const store = createWsAuthStore<number>(async () => 7)
    const a = ws('c3')

    await store.handleAuth(a.ws, 't')
    expect(store.get(a.ws)).toBe(7)

    store.forget(a.ws)
    expect(store.get(a.ws)).toBeUndefined()
  })
})

describe('socketUser', () => {
  const app = testApp()

  // Opens a socket with `cookie`, and gives what the server read as its user.
  async function openedAs(cookie: string | undefined): Promise<unknown> {
    const { promise, resolve } = Promise.withResolvers<unknown>()
    const server = new Elysia()
      .use(app.app)
      .ws('/socket', {
        async open(ws) {
          ws.send(JSON.stringify(await app.auth.socketUser(ws)))
        },
      })
      .listen(0)

    try {
      // Bun's WebSocket takes headers, which the DOM typing it shares does not know.
      const socket = new WebSocket(`ws://localhost:${server.server!.port}/socket`, cookie === undefined ? undefined : { headers: { cookie } } as never)

      socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))))
      const user = await promise

      socket.close()

      return user
    }
    finally {
      await server.stop()
    }
  }

  test('reads who opened the socket off the cookie its upgrade carried, null for an anonymous one', async () => {
    await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
    const ada = app.browser()

    await ada.fetch('/sign-in/u1', { method: 'POST' })

    expect(await openedAs([...ada.cookies].map(([name, value]) => `${name}=${value}`).join('; '))).toMatchObject({ id: 'u1', email: 'ada@example.com' })
    expect(await openedAs(undefined)).toBeNull()
  })

  test('answers null for a socket opened without the plugin', async () => {
    expect(await app.auth.socketUser({ data: {} })).toBeNull()
    expect(await app.auth.socketUser({})).toBeNull()
  })
})
