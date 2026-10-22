import type { AnyElysia } from 'elysia'
import type { GuardContext } from 'kay'
import { afterEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { setSite } from '../../../src/runtime/site'
import { guard } from '../src/guard'
import { memoryAuthStore } from '../src/memoryStore'
import { testApp, userRecord } from './helpers/app'

afterEach(() => {
  setSite(undefined)
})

async function run(ctx: GuardContext, options?: Parameters<typeof guard>[0]): Promise<string> {
  try {
    await guard(options)(ctx)

    return 'passed'
  }
  catch (outcome) {
    return (outcome as Error).message
  }
}

// The context a kay page would see, built by the plugin, with the cookie of a visitor.
async function contextOf(plugin: AnyElysia, cookie = ''): Promise<object> {
  return new Promise((resolve) => {
    void new Elysia().use(plugin).get('/', (ctx) => {
      resolve(ctx)

      return 'ok'
    }).handle(new Request('http://localhost/', { headers: { cookie } }))
  })
}

function guardContext(locals: object, path = '/', method = 'GET'): GuardContext {
  const url = new URL(`http://localhost${path}`)

  return {
    request: new Request(url, { method }),
    url,
    locals,
    params: {},
    redirect: (location: string) => {
      throw new Error(`redirect ${location}`)
    },
    deny: (status = 403) => {
      throw new Error(`deny ${status}`)
    },
  } as unknown as GuardContext
}

describe('guard() from kayjs-auth', () => {
  test('names the missing plugin when the request has no auth', async () => {
    expect(await run(guardContext({}))).toContain('no `auth` in this context')
  })

  test('asks an auth that is not an instance of this copy of Auth, as a second copy of kayjs-auth would load', async () => {
    const asked: unknown[] = []
    const other = { guarded: async (_ctx: unknown, options: unknown) => {
      asked.push(options)
    } }

    expect(await run(guardContext({ auth: other }), { redirect: '/in' })).toBe('passed')
    expect(asked).toEqual([{ redirect: '/in' }])
  })

  test('stops an anonymous visitor as auth.guard() does, with no import of the createAuth result', async () => {
    const { auth } = testApp({ pages: true })
    const anonymous = await contextOf(auth.plugin)

    expect(await run(guardContext(anonymous, '/account?tab=2'))).toBe('redirect /auth/sign-in?redirect=%2Faccount%3Ftab%3D2')
    expect(await run(guardContext(anonymous, '/', 'POST'))).toBe('deny 401')
  })

  test('lets a signed-in user through, and asks for a role when given `require`', async () => {
    const store = memoryAuthStore()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', roles: ['editor'] }))

    const { auth } = testApp({ store })
    const cookie = await auth.sessionCookie('u1')
    const signedIn = await contextOf(auth.plugin, cookie)

    expect(await run(guardContext(signedIn))).toBe('passed')
    expect(await run(guardContext(signedIn), { require: 'editor' })).toBe('passed')
    expect(await run(guardContext(signedIn), { require: 'admin' })).toBe('deny 403')
  })
})
