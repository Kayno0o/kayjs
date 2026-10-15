import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Elysia } from 'elysia'
import { createWsAuthStore } from '../src/wsAuth'
import { testApp, userRecord } from './helpers/app'

afterEach(() => {
  setSystemTime()
})

// Moves the clock past the 30 seconds a user read stays good.
function later(): void {
  setSystemTime(new Date(Date.now() + 31 * 1000))
}

describe('createWsAuthStore', () => {
  const ws = (id: string) => {
    const sent: string[] = []

    return { ws: { id, send: (m: string) => sent.push(m), close: () => undefined }, sent }
  }

  test('stores the verified value per connection and acks', async () => {
    const store = createWsAuthStore<{ userId: number }>(async token => token === 'good' ? { userId: 1 } : null)
    const a = ws('c1')

    await store.handleAuth(a.ws, 'good')

    expect(await store.get(a.ws)).toEqual({ userId: 1 })
    expect(a.sent).toEqual([JSON.stringify({ type: 'authed' })])
  })

  test('a rejected token stores nothing and sends no ack', async () => {
    const store = createWsAuthStore<{ userId: number }>(async () => null)
    const a = ws('c2')

    await store.handleAuth(a.ws, 'bad')

    expect(await store.get(a.ws)).toBeUndefined()
    expect(a.sent).toEqual([])
  })

  test('forget drops the stored value', async () => {
    const store = createWsAuthStore<number>(async () => 7)
    const a = ws('c3')

    await store.handleAuth(a.ws, 't')
    expect(await store.get(a.ws)).toBe(7)

    store.forget(a.ws)
    expect(await store.get(a.ws)).toBeUndefined()
  })

  test('checks the token again past 30 seconds, closing the socket once it is refused', async () => {
    let valid = true
    let closed = 0
    const store = createWsAuthStore<number>(async () => valid ? 7 : null)
    const a = { id: 'c4', send: () => undefined, close: () => void closed++ }

    await store.handleAuth(a, 't')
    valid = false

    expect(await store.get(a)).toBe(7)
    expect(closed).toBe(0)

    later()

    expect(await store.get(a)).toBeUndefined()
    expect(closed).toBe(1)
    expect(await store.get(a)).toBeUndefined()
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

    expect(await openedAs(ada.cookieHeader())).toMatchObject({ id: 'u1', email: 'ada@example.com' })
    expect(await openedAs(undefined)).toBeNull()
  })

  // Opens a socket with `cookie` whose every message asks the server who it serves, through `socketUser` or `ws.data.auth.user()`.
  async function socketAs(cookie: string, read: 'socketUser' | 'data') {
    const server = new Elysia()
      .use(app.app)
      .ws('/socket', {
        async message(ws) {
          ws.send(JSON.stringify(read === 'socketUser' ? await app.auth.socketUser(ws) : await ws.data.auth.user()))
        },
      })
      .listen(0)
    const socket = new WebSocket(`ws://localhost:${server.server!.port}/socket`, { headers: { cookie } } as never)
    const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code)))

    await new Promise(resolve => socket.addEventListener('open', resolve))

    return {
      closed,
      ask: async () => new Promise<unknown>((resolve) => {
        socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true })
        socket.send('who')
      }),
      send: () => socket.send('who'),
      stop: async () => {
        socket.close()
        await server.stop()
      },
    }
  }

  test('reads the user again past 30 seconds, and closes a socket whose session was signed out', async () => {
    await app.store.users.create(userRecord({ id: 'u2', email: 'bob@example.com' }))
    const bob = app.browser()

    await bob.fetch('/sign-in/u2', { method: 'POST' })
    const socket = await socketAs(bob.cookieHeader(), 'socketUser')

    try {
      expect(await socket.ask()).toMatchObject({ id: 'u2' })
      await bob.fetch('/sign-out', { method: 'POST' })
      expect(await socket.ask()).toMatchObject({ id: 'u2' })

      later()
      socket.send()

      expect(await socket.closed).toBe(1008)
    }
    finally {
      await socket.stop()
    }
  })

  test('a ban reaches a socket\'s `ws.data.auth.user()` past 30 seconds', async () => {
    await app.store.users.create(userRecord({ id: 'u3', email: 'cleo@example.com' }))
    const cleo = app.browser()

    await cleo.fetch('/sign-in/u3', { method: 'POST' })
    const socket = await socketAs(cleo.cookieHeader(), 'data')

    try {
      expect(await socket.ask()).toMatchObject({ id: 'u3' })
      await app.store.users.update('u3', { bannedAt: new Date() })
      later()
      expect(await socket.ask()).toBeNull()
    }
    finally {
      await socket.stop()
    }
  })

  test('a banned user\'s token reads as no one', async () => {
    await app.store.users.create(userRecord({ id: 'u4', email: 'dan@example.com' }))
    const issued = await app.auth.issueToken('u4', 'Display')

    expect(issued.ok && await app.auth.userFromToken(issued.token)).toMatchObject({ id: 'u4' })
    await app.store.users.update('u4', { bannedAt: new Date() })
    expect(issued.ok && await app.auth.userFromToken(issued.token)).toBeNull()
  })

  test('answers null for a socket opened without the plugin', async () => {
    expect(await app.auth.socketUser({ data: {} })).toBeNull()
    expect(await app.auth.socketUser({})).toBeNull()
  })
})
