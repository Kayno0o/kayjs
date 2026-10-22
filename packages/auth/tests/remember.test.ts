import { describe, expect, setSystemTime, test } from 'bun:test'
import { testApp, userRecord } from './helpers/app'

const PASSWORD = 'correct horse battery'
const DAY = 24 * 60 * 60

async function setup() {
  const app = testApp()

  await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))

  return app
}

// Calls `auth[method](...args)` in `browser`, answering the session cookie it set.
async function cookieOf(browser: ReturnType<ReturnType<typeof testApp>['browser']>, method: string, ...args: unknown[]): Promise<string> {
  const response = await browser.fetch(`/call/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })

  return response.headers.getSetCookie().find(line => line.startsWith('kay_session='))!
}

function later(seconds: number) {
  setSystemTime(new Date(Date.now() + seconds * 1000))
}

describe('remember me', () => {
  test('a remembered sign-in outlives the session plugin\'s maxAge, up to rememberMaxAge unseen', async () => {
    const { browser, store } = await setup()
    const ada = browser()

    expect(await cookieOf(ada, 'register', { email: 'grace@example.com', password: PASSWORD }, { remember: true })).toContain(`Max-Age=${90 * DAY}`)

    const [session] = await store.sessions.listByUser((await ada.json('/me') as { id: string }).id)

    expect(session!.maxAge).toBe(90 * DAY)

    try {
      later(60 * DAY)
      expect(await ada.json('/me')).toMatchObject({ email: 'grace@example.com' })
      later(91 * DAY)
      expect(await ada.json('/me')).toBe('anonymous')
    }
    finally {
      setSystemTime()
    }
  })

  test('a sign-in not to be remembered has a cookie dying with the browser, and lasts a day unseen', async () => {
    const { browser, store } = await setup()
    const ada = browser()
    const cookie = await cookieOf(ada, 'signIn', { id: 'u1' }, { remember: false })

    expect(cookie).not.toContain('Max-Age')
    expect((await store.sessions.listByUser('u1'))[0]!.maxAge).toBe(DAY)

    try {
      later(DAY + 60)
      expect(await ada.json('/me')).toBe('anonymous')
    }
    finally {
      setSystemTime()
    }
  })

  test('a sign-in saying nothing gets kay\'s lifetime back, whatever the one before in that browser chose', async () => {
    const { browser, store } = await setup()
    const ada = browser()

    await cookieOf(ada, 'signIn', { id: 'u1' }, { remember: true })
    await ada.fetch('/sign-out', { method: 'POST' })

    expect(await cookieOf(ada, 'signIn', { id: 'u1' })).toContain(`Max-Age=${30 * DAY}`)
    expect((await store.sessions.listByUser('u1'))[0]!.maxAge).toBeNull()
  })

  test('the choice holds through a failed attempt only until the next sign-in call', async () => {
    const { browser, store } = await setup()
    const ada = browser()

    await ada.call('register', { email: 'grace@example.com', password: PASSWORD })
    await ada.fetch('/sign-out', { method: 'POST' })
    expect(await ada.call('signInWithPassword', { identifier: 'grace@example.com', password: 'wrong password' }, { remember: true })).toMatchObject({ ok: false })
    expect(await cookieOf(ada, 'signInWithPassword', { identifier: 'grace@example.com', password: PASSWORD })).toContain(`Max-Age=${30 * DAY}`)

    const { id } = await ada.json('/me') as { id: string }

    expect((await store.sessions.listByUser(id))[0]!.maxAge).toBeNull()
  })
})
