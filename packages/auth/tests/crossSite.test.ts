import { describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { testApp, userRecord } from './helpers/app'

const EVIL = { origin: 'http://evil.example' }

describe('a plain Elysia app on auth.plugin', () => {
  async function signedIn() {
    const app = testApp()

    await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
    const ada = app.browser()

    await ada.fetch('/sign-in/u1', { method: 'POST' })

    return { app, ada }
  }

  test('refuses a POST from another origin before it signs anyone in', async () => {
    const app = testApp()

    await app.store.users.create(userRecord({ id: 'u1' }))
    const victim = app.browser()

    const response = await victim.fetch('/sign-in/u1', { method: 'POST', headers: EVIL })

    expect(response.status).toBe(403)
    expect(victim.cookies.size).toBe(0)
    expect(await victim.json('/me')).toBe('anonymous')
  })

  test('refuses a cross-site POST of a signed-in user and keeps them signed in', async () => {
    const { ada } = await signedIn()

    expect((await ada.fetch('/sign-out', { method: 'POST', headers: EVIL })).status).toBe(403)
    expect((await ada.fetch('/call/changeUsername', { method: 'POST', headers: { ...EVIL, 'content-type': 'application/json' }, body: '["mallory"]' })).status).toBe(403)
    expect(await ada.json('/me')).toMatchObject({ id: 'u1' })
  })

  test('refuses a POST whose Sec-Fetch-Site says another site, with no Origin', async () => {
    const { ada } = await signedIn()

    expect((await ada.fetch('/sign-out', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await ada.fetch('/sign-out', { method: 'POST', headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403)
    expect(await ada.json('/me')).toMatchObject({ id: 'u1' })
  })

  test('lets the same origin, a request with no Origin and a safe method through', async () => {
    const { ada } = await signedIn()

    expect(await ada.json('/me', { headers: EVIL })).toMatchObject({ id: 'u1' })
    expect((await ada.fetch('/sign-in/u1', { method: 'POST', headers: { 'origin': 'http://localhost', 'sec-fetch-site': 'same-origin' } })).status).toBe(200)
    expect((await ada.fetch('/sign-in/u1', { method: 'POST' })).status).toBe(200)
    expect((await ada.fetch('/sign-out', { method: 'POST', headers: { 'sec-fetch-site': 'none' } })).status).toBe(200)
  })

  test('takes the host of `url` as its own, for a proxy that does not pass Host on', async () => {
    const app = testApp({ url: 'https://app.example.com' })

    await app.store.users.create(userRecord({ id: 'u1' }))
    const browser = app.browser()

    expect((await browser.fetch('/sign-in/u1', { method: 'POST', headers: { origin: 'https://app.example.com' } })).status).toBe(200)
    expect((await browser.fetch('/sign-in/u1', { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403)
  })

  test('leaves a request carrying a bearer token alone, which no page can add', async () => {
    const { app } = await signedIn()
    const response = await app.app.handle(new Request('http://localhost/call/user', { method: 'POST', headers: { ...EVIL, 'authorization': 'Bearer nope', 'content-type': 'application/json' }, body: '[]' }))

    expect(response.status).toBe(200)
  })

  test('leaves the OAuth form_post callback, a cross-site POST by design, to answer', async () => {
    const app = testApp()
    const response = await app.app.handle(new Request('http://localhost/auth/apple/callback', { method: 'POST', headers: { ...EVIL, 'content-type': 'application/x-www-form-urlencoded' }, body: 'code=1' }))

    expect(response.status).toBe(404)
  })

  test('socketUser answers nobody and closes a socket whose upgrade came from another origin', async () => {
    const { app, ada } = await signedIn()
    const cookie = [...ada.cookies].map(([name, value]) => `${name}=${value}`).join('; ')

    const server = new Elysia()
      .use(app.app)
      .ws('/socket', {
        async message(ws) {
          ws.send(JSON.stringify(await app.auth.socketUser(ws)))
        },
      })
      .listen(0)

    async function ask(origin: string) {
      const socket = new WebSocket(`ws://localhost:${server.server!.port}/socket`, { headers: { cookie, origin } } as never)
      const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code)))
      const answer = new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(String(event.data))), { once: true }))

      await new Promise(resolve => socket.addEventListener('open', resolve))
      socket.send('who')

      const result = await Promise.race([answer, closed])

      socket.close()

      return { answer: result }
    }

    try {
      expect((await ask(`http://localhost:${server.server!.port}`)).answer).toMatchObject({ id: 'u1' })
      expect((await ask('http://evil.example')).answer).toBe(1008)
    }
    finally {
      await server.stop()
    }
  })
})
