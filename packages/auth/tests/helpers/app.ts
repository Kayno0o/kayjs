import type { AuthOptions, AuthSessionData } from '../../src/auth'
import type { AuthStore, UserRecord } from '../../src/store'
import { Elysia } from 'elysia'
import { session } from 'kay/server'
import { createAuth } from '../../src/auth'
import { memoryStore } from '../../src/memoryStore'

export const SECRET = 'a-test-secret-that-is-long-enough-for-kay-auth'

export function userRecord(fields: Partial<UserRecord> & Pick<UserRecord, 'id'>): UserRecord {
  return {
    email: null,
    emailVerifiedAt: null,
    username: null,
    passwordHash: null,
    totpSecret: null,
    totpEnabledAt: null,
    totpLastStep: 0,
    roles: [],
    sessionVersion: 0,
    lastSignIn: null,
    createdAt: new Date(),
    ...fields,
  }
}

// An Elysia app on kay-auth with routes to drive it, and a browser per call that keeps its own cookies.
export function testApp(options: Partial<Omit<AuthOptions<AuthSessionData, 'admin' | 'editor'>, 'store'>> & { store?: AuthStore } = {}) {
  const store = options.store ?? memoryStore()
  const auth = createAuth({ sessions: session<AuthSessionData>({ secret: SECRET }), secret: SECRET, roles: { admin: ['editor'], editor: [] }, ...options, store })
  const app = new Elysia()
    .use(auth.plugin)
    .get('/me', async ({ auth }) => (await auth.user()) ?? 'anonymous')
    .post('/sign-in/:id', async ({ auth, params }) => {
      await auth.signIn({ id: params.id })

      return 'ok'
    })
    .post('/register', async ({ auth, body }) => auth.register(body as Parameters<typeof auth.register>[0]))
    .post('/password', async ({ auth, body }) => auth.signInWithPassword(body as Parameters<typeof auth.signInWithPassword>[0]))
    .post('/sign-out', async ({ auth }) => {
      await auth.signOut()

      return 'ok'
    })
    .post('/sign-out-everywhere', async ({ auth, query }) => {
      await auth.signOutEverywhere({ keepThisOne: query.keep === '1' })

      return 'ok'
    })

  return { auth, app, store, browser: () => browser(app) }
}

export function browser(app: { handle: (request: Request) => Promise<Response> }) {
  const cookies = new Map<string, string>()

  return {
    cookies,
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers)

      if (cookies.size > 0)
        headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '))

      const response = await app.handle(new Request(`http://localhost${path}`, { ...init, headers }))

      for (const line of response.headers.getSetCookie()) {
        const cookie = Bun.Cookie.parse(line)

        if (cookie.isExpired() || cookie.value === '')
          cookies.delete(cookie.name)
        else
          cookies.set(cookie.name, cookie.value)
      }

      return response
    },
    // Posts `body` as JSON and reads the answer.
    async post(path: string, body: unknown): Promise<any> {
      return this.json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    },
    async json(path: string, init: RequestInit = {}): Promise<unknown> {
      const response = await this.fetch(path, init)
      const text = await response.text()

      return text.startsWith('{') ? JSON.parse(text) : text
    },
  }
}
