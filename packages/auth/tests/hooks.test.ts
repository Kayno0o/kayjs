import type { AuthEventInfo, AuthHookContext } from '../src/events'
import { describe, expect, test } from 'bun:test'
import { refuse } from 'kay'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
// Where kay sends what libraries log through `logFrom`, as the app's `log` setting says.
const LOG_SINK = Symbol.for('kay.log')

async function logging<Result>(run: () => Promise<Result>): Promise<{ result: Result, logged: unknown[][] }> {
  const logged: unknown[][] = []
  const global = globalThis as { [LOG_SINK]?: unknown }
  const sink = global[LOG_SINK]

  global[LOG_SINK] = (...args: unknown[]) => logged.push(args)

  try {
    return { result: await run(), logged }
  }
  finally {
    global[LOG_SINK] = sink
  }
}

describe('onEvent', () => {
  test('hears the account\'s events, with an AuthHookContext', async () => {
    const heard: AuthEventInfo[] = []
    const { browser } = testApp({
      onEvent: (info) => {
        heard.push(info)
      },
    })

    await browser().call('password.register', { email: 'ada@example.com', password: PASSWORD })
    await browser().json('/password', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1', 'user-agent': 'Firefox' }, body: JSON.stringify({ identifier: 'ada@example.com', password: 'wrong password' }) })

    const failed = heard.find(info => info.event === 'sign-in-failed')

    expect(failed).toMatchObject({ method: 'password', user: { email: 'ada@example.com' }, context: { ip: '10.0.0.1', userAgent: 'Firefox', actor: null } })
  })

  test('a throw is reported with its source, and the sign-in and the audit entry stand', async () => {
    const { browser, store } = testApp({
      audit: true,
      onEvent: () => {
        throw new Error('down')
      },
    })
    const ada = browser()
    const { logged } = await logging(async () => ada.call('password.register', { email: 'ada@example.com', password: PASSWORD }))

    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })

    expect((await store.audit!.list({ limit: 10 })).map(entry => entry.event)).toEqual(['signed-in'])
    expect(logged).toContainEqual(['error', 'auth.onEvent failed', expect.objectContaining({ message: 'down' }), undefined, 'kay'])
  })
})

describe('beforeDelete', () => {
  async function registered(options: Parameters<typeof testApp>[0]) {
    const app = testApp({ admin: 'admin', ...options })
    const ada = app.browser()
    const admin = app.browser()

    await ada.call('password.register', { email: 'ada@example.com', password: PASSWORD })

    const { user } = await admin.callHas('user', 'password.register', { email: 'root@example.com', password: PASSWORD })

    await app.store.users.update(user.id, { roles: ['admin'] })

    // Another admin, so this one is not the last.
    const grace = app.browser()
    const { user: second } = await grace.callHas('user', 'password.register', { email: 'grace@example.com', password: PASSWORD })

    await app.store.users.update(second.id, { roles: ['admin'] })

    return { ...app, ada, admin, grace, adminId: user.id }
  }

  test('false keeps the account and answers a refusal, 403 by default', async () => {
    const { ada, store } = await registered({ beforeDelete: () => false })

    expect(await ada.call('account.delete', { password: PASSWORD })).toMatchObject({ ok: false, error: { code: 'refused', status: 403, message: 'Refused' } })
    expect(await store.users.findByEmail('ada@example.com')).toBeDefined()
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })
  })

  test('a thrown refuse() answers its message, status and fields, for the admin too', async () => {
    const { ada, admin, store } = await registered({
      beforeDelete: ({ user }) => {
        if (user.email === 'ada@example.com')
          refuse('Ada has open orders', { status: 409, errors: { orders: 'open' } })
      },
    })
    const id = (await store.users.findByEmail('ada@example.com'))!.id
    const expected = { ok: false, error: { code: 'refused', status: 409, message: 'Ada has open orders', errors: { orders: 'open' } } }

    expect(await ada.call('account.delete', { password: PASSWORD })).toMatchObject(expected)
    expect(await admin.call('admin.deleteUser', id)).toMatchObject(expected)
    expect(await store.users.get(id)).toBeDefined()
  })

  test('a plain throw refuses with 500 and is reported', async () => {
    const { ada, store } = await registered({
      beforeDelete: () => {
        throw new Error('down')
      },
    })
    const { result, logged } = await logging(async () => ada.call('account.delete', { password: PASSWORD }))

    expect(result).toMatchObject({ ok: false, error: { code: 'refused', status: 500 } })
    expect(logged).toContainEqual(['error', 'auth.beforeDelete failed', expect.objectContaining({ message: 'down' }), undefined, 'kay'])
    expect(await store.users.findByEmail('ada@example.com')).toBeDefined()
  })

  test('a refused admin keeps their roles', async () => {
    const { admin, adminId, store } = await registered({ beforeDelete: ({ user }) => user.email === 'root@example.com' ? false : undefined })

    expect(await admin.call('account.delete', { password: PASSWORD })).toMatchObject({ ok: false })
    expect((await store.users.get(adminId))?.roles).toEqual(['admin'])
  })

  test('is told the user and the context, the admin as actor', async () => {
    const told: [string, string | null | undefined][] = []
    const { admin, grace, store } = await registered({
      beforeDelete: ({ user, context }) => {
        told.push([user.email!, context.actor?.email])
      },
    })

    expect(await grace.call('account.delete', { password: PASSWORD })).toEqual({ ok: true })
    expect(await admin.call('admin.deleteUser', (await store.users.findByEmail('ada@example.com'))!.id)).toEqual({ ok: true })
    expect(told).toEqual([['grace@example.com', undefined], ['ada@example.com', 'root@example.com']])
  })

  test('a throw keeps the account', async () => {
    const { ada, store } = await registered({
      beforeDelete: () => {
        throw new Error('app down')
      },
    })

    expect(await ada.call('account.delete', { password: PASSWORD })).toMatchObject({ ok: false, error: { status: 500 } })
    expect(await store.users.findByEmail('ada@example.com')).toBeDefined()
  })
})

describe('onSignUp', () => {
  test('is told the user and the context, and a throw is reported while the registration, guest and sign-in stand', async () => {
    const contexts: AuthHookContext[] = []
    const { browser, store } = testApp({
      onSignUp: ({ context }) => {
        contexts.push(context)

        throw new Error('app down')
      },
    })
    const ada = browser()
    const { result, logged } = await logging(async () => ada.call('password.register', { email: 'ada@example.com', password: PASSWORD }))
    const guest = browser()

    expect(result).toMatchObject({ ok: true })
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })
    expect(await guest.call('signInAsGuest')).toMatchObject({ ok: true })
    expect(contexts).toHaveLength(2)
    expect(contexts[0]).toMatchObject({ actor: null })
    expect(logged).toContainEqual(['error', 'auth.onSignUp failed', expect.objectContaining({ message: 'app down' }), undefined, 'kay'])
    expect((await store.users.list({ offset: 0, limit: 10 })).total).toBe(2)
  })
})
