import { describe, expect, expectTypeOf, test } from 'bun:test'
import { Elysia } from 'elysia'
import { Auth } from '../src/auth'
import { testApp } from './helpers/app'

describe('auth.gate() types', () => {
  test('a route after the gate sees `auth` and takes the `auth:` and `scope:` options', async () => {
    const { auth } = testApp()
    const app = new Elysia({ prefix: '/api' })
      .use(auth.gate())
      .get('/me', async ({ auth }) => {
        expectTypeOf(auth).toMatchTypeOf<Auth>()

        return (await auth.user())?.email ?? 'nobody'
      })
      .get('/admin', () => 'ok', { auth: 'admin' })
      .get('/open', ({ auth }) => auth instanceof Auth, { auth: false })

    expect((await app.handle(new Request('http://localhost/api/me'))).status).toBe(401)
    expect(await (await app.handle(new Request('http://localhost/api/open'))).text()).toBe('true')
  })
})
