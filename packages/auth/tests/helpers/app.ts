import type { Auth, AuthOptions, AuthSessionData } from '../../src/auth'
import type { AuthStore, UserRecord } from '../../src/store'
import { Elysia } from 'elysia'
import { session } from 'kay/server'
import { cookieJar } from 'kay/test'
import { createAuth } from '../../src/auth'
import { memoryStore } from '../../src/memoryStore'

export const SECRET = 'a-test-secret-that-is-long-enough-for-kayjs-auth'

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
    locale: null,
    guest: false,
    bannedAt: null,
    bannedUntil: null,
    banReason: null,
    createdAt: new Date(),
    ...fields,
  }
}

// A store numbering its users itself, as one over a serial id column does: the id kayjs-auth picks is dropped.
export function serialStore(): AuthStore {
  const store = memoryStore()
  let last = 0

  return {
    ...store,
    users: {
      ...store.users,
      async create(user) {
        const stored = { ...user, id: String(++last) }

        await store.users.create(stored)

        return stored
      },
    },
  }
}

// An Elysia app on kayjs-auth with routes to drive it, and a browser per call that keeps its own cookies.
export function testApp<const Scope extends string = never, OrgRole extends string = never>(options: Partial<Omit<AuthOptions<AuthSessionData, 'admin' | 'editor', '/auth', Scope, OrgRole>, 'store'>> & { store?: AuthStore } = {}) {
  const store = options.store ?? memoryStore()
  // The default proof of work stays off unless a test gives `captcha`, `undefined` included, as a script calling the API sends no solution.
  const captcha = 'captcha' in options ? options.captcha : false
  const auth = createAuth<AuthSessionData, 'admin' | 'editor', '/auth', Scope, OrgRole>({ sessions: session<AuthSessionData>({ secret: SECRET }), secret: SECRET, roles: { admin: ['editor'], editor: [] }, proxy: { hops: 1 }, ...options, captcha, store })
  const app = new Elysia()
    .use(auth.plugin)
    .get('/me', async ({ auth }) => (await auth.user()) ?? 'anonymous')
    .post('/sign-in/:id', async ({ auth, params }) => {
      await auth.signIn({ id: params.id })

      return 'ok'
    })
    .post('/register', async ({ auth, body }) => auth.register(body as Parameters<typeof auth.register>[0]))
    .post('/password', async ({ auth, body }) => auth.signInWithPassword(body as Parameters<typeof auth.signInWithPassword>[0]))
    // Calls any method of `auth` with the posted arguments, so a test drives what an action would.
    .post('/call/:method', async ({ auth, params, body }) => {
      const method = (auth as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[params.method]!

      return (await method.apply(auth, body as unknown[])) ?? null
    })
    .post('/sign-out', async ({ auth }) => {
      await auth.signOut()

      return 'ok'
    })
    .post('/sign-out-everywhere', async ({ auth, query }) => {
      await auth.signOutEverywhere({ keepThisOne: query.keep === '1' })

      return 'ok'
    })

  const browserOn = (on: { handle: (request: Request) => Promise<Response> }) => browser<Auth<Scope, 'admin' | 'editor', OrgRole>>(on)

  // `browserOn` drives an app wrapping this one, such as one adding routes.
  return { auth, app, store, browser: () => browserOn(app), browserOn }
}

type Method<A, M extends keyof A> = A[M] extends (...args: infer Args) => infer Answer ? { args: Args, answer: Awaited<Answer> } : never

// What an answer is once it went through JSON: dates are strings, and a method answering nothing answers null.
type Wire<T> = T extends undefined ? null : Shape<T>

type Shape<T> = T extends Date ? string : T extends ArrayBufferLike | ArrayBufferView ? T : T extends readonly (infer Item)[] ? Shape<Item>[] : T extends object ? { [Key in keyof T]: Shape<T[Key]> } : T

export function browser<A = Record<string, never>>(app: { handle: (request: Request) => Promise<Response> }) {
  const jar = cookieJar()

  return {
    cookies: jar.cookies,
    // The `cookie` header this browser sends.
    cookieHeader: jar.header,
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      return jar.send(async request => app.handle(request), new Request(`http://localhost${path}`, init))
    },
    // Calls `auth[method](...args)` in this browser and reads the answer.
    async call<M extends keyof A & string>(method: M, ...args: Method<A, M>['args']): Promise<Wire<Method<A, M>['answer']>> {
      return await this.post(`/call/${method}`, args) as Wire<Method<A, M>['answer']>
    },
    // As `call`, for a test that needs the answer of a call that must have worked: anything but `ok: true` fails it.
    async callOk<M extends keyof A & string>(method: M, ...args: Method<A, M>['args']): Promise<Extract<Wire<Method<A, M>['answer']>, { ok: true }>> {
      const answer = await this.call(method, ...args)

      if (typeof answer !== 'object' || answer === null || !('ok' in answer) || answer.ok !== true) {
        throw new Error(`${method} did not work: ${JSON.stringify(answer)}`)
      }

      return answer as Extract<Wire<Method<A, M>['answer']>, { ok: true }>
    },
    // As `callOk`, for an answer that has `key` only in some of its successes, such as a registration that signed the user in.
    async callHas<Key extends string, M extends keyof A & string>(key: Key, method: M, ...args: Method<A, M>['args']): Promise<Extract<Wire<Method<A, M>['answer']>, { ok: true } & Record<Key, unknown>>> {
      const answer = await this.callOk(method, ...args)

      if (!(key in answer)) {
        throw new Error(`${method} answered without ${key}: ${JSON.stringify(answer)}`)
      }

      return answer as Extract<Wire<Method<A, M>['answer']>, { ok: true } & Record<Key, unknown>>
    },
    // Posts `body` as JSON and reads the answer.
    async post(path: string, body: unknown): Promise<unknown> {
      return this.json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    },
    async json(path: string, init: RequestInit = {}): Promise<unknown> {
      const response = await this.fetch(path, init)
      const text = await response.text()

      try {
        return JSON.parse(text)
      }
      // Plain text, such as 'anonymous'.
      catch {
        return text
      }
    },
  }
}

export type TestBrowser = ReturnType<ReturnType<typeof testApp>['browser']>
