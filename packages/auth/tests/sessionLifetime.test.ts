import { describe, expect, setSystemTime, test } from 'bun:test'
import { session } from 'kay/server'
import { memoryStore } from '../src/memoryStore'
import { SECRET, testApp, userRecord } from './helpers/app'
import { mailbox } from './helpers/mail'

const DAY = 24 * 60 * 60
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }

type Lifetimes = Parameters<typeof session>[0]

async function setup(lifetimes: Partial<Lifetimes> = {}, extra: Parameters<typeof testApp>[0] = {}) {
  const app = testApp({ sessions: session({ secret: SECRET, ...lifetimes }), ...extra })

  await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))

  return app
}

async function signedIn(app: Awaited<ReturnType<typeof setup>>, remember?: boolean) {
  const ada = app.browser()
  const response = await ada.fetch('/call/signIn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ id: 'u1' }, remember === undefined ? {} : { remember }]) })
  const stored = (await app.store.sessions.listByUser('u1')).at(-1)

  return { ada, cookie: response.headers.getSetCookie().find(line => line.startsWith('session='))!, stored: stored! }
}

describe('a sign-in follows the session plugin\'s lifetimes', () => {
  test('with the plugin\'s defaults: 30 days unseen, a day for a browser session, 90 for a remembered one', async () => {
    const app = await setup()

    expect((await signedIn(app)).cookie).toContain(`Max-Age=${30 * DAY}`)
    expect((await signedIn(app, false)).stored.maxAge).toBe(DAY)
    expect((await signedIn(app, true)).stored.maxAge).toBe(90 * DAY)
  })

  test('with maxAge only: no remember gets it, not 30 days', async () => {
    const app = await setup({ maxAge: '7d' })
    const { cookie, stored } = await signedIn(app)

    expect(cookie).toContain(`Max-Age=${7 * DAY}`)
    expect(stored.maxAge).toBeNull()
  })

  test('a session unseen past the plugin\'s maxAge is over and dropped from the list', async () => {
    const app = await setup({ maxAge: '7d' })
    const { ada } = await signedIn(app)

    try {
      setSystemTime(new Date(Date.now() + 6 * DAY * 1000))
      expect(await ada.json('/me')).toMatchObject({ id: 'u1' })
      setSystemTime(new Date(Date.now() + 8 * DAY * 1000))
      expect(await ada.json('/me')).toBe('anonymous')
    }
    finally {
      setSystemTime()
    }
  })

  test('with absoluteMaxAge only: the list and the cookie end the sign-in together, a remembered one included', async () => {
    const app = await setup({ absoluteMaxAge: '10d' })
    const { ada, cookie } = await signedIn(app, true)

    // The cookie never outlasts the plugin's absolute end.
    expect(cookie).toContain(`Max-Age=${10 * DAY}`)

    try {
      setSystemTime(new Date(Date.now() + 5 * DAY * 1000))
      expect(await ada.call('sessions')).toHaveLength(1)
      setSystemTime(new Date(Date.now() + 6 * DAY * 1000))
      expect(await ada.json('/me')).toBe('anonymous')
      expect(await app.browser().call('sessions')).toEqual([])
    }
    finally {
      setSystemTime()
    }
  })

  test('with browserMaxAge: remember false lasts it unseen, and the cookie dies with the browser', async () => {
    const app = await setup({ browserMaxAge: '2h' })
    const { cookie, stored } = await signedIn(app, false)

    expect(cookie).not.toContain('Max-Age')
    expect(stored.maxAge).toBe(2 * 60 * 60)
  })

  test('remember true lasts rememberMaxAge, as a duration string, and remember undefined the plugin\'s maxAge', async () => {
    const app = await setup({ maxAge: '7d', absoluteMaxAge: '200d' }, { rememberMaxAge: '45d' })

    expect((await signedIn(app, true)).stored.maxAge).toBe(45 * DAY)
    expect((await signedIn(app)).stored.maxAge).toBeNull()
  })

  test('the pruning keeps what the plugin lets live', async () => {
    const limits: unknown[] = []
    const store = { ...memoryStore(), prune: async (given: unknown) => void limits.push(given) }
    const app = await setup({ maxAge: '7d', absoluteMaxAge: '20d', browserMaxAge: '1h' }, { store, rememberMaxAge: '15d' })

    await app.browser().json('/me')
    expect(limits).toMatchObject([{ sessionMaxAge: 15 * DAY, sessionAbsoluteMaxAge: 20 * DAY }])
  })
})

describe('a magic link carries the remember choice', () => {
  async function linked(remember: boolean | undefined) {
    const { mails, mailer } = mailbox()
    const app = await setup({}, { url: 'https://site.test', email: { mailer, links: LINKS } })
    const asker = app.browser()

    await asker.call('requestMagicLink', 'ada@example.com', remember === undefined ? {} : { remember })

    const url = new URL(mails.findLast(mail => mail.kind === 'magic-link')!.url!)

    return { app, token: url.searchParams.get('token')! }
  }

  test('opened in another browser, it signs in as the asking browser chose', async () => {
    for (const [remember, expected] of [[true, 90 * DAY], [false, DAY], [undefined, null]] as const) {
      const { app, token } = await linked(remember)
      const other = app.browser()

      expect(await other.call('signInWithMagicLink', token)).toMatchObject({ ok: true })
      expect((await app.store.sessions.listByUser('u1'))[0]!.maxAge).toBe(expected)
    }
  })

  test('the token stored is the same without the choice, so a link with it stripped still works', async () => {
    const { app, token } = await linked(true)
    const bare = token.slice(0, -2)

    expect(token.endsWith('.r')).toBe(true)
    expect(await app.browser().call('signInWithMagicLink', bare)).toMatchObject({ ok: true })
  })

  test('a mark on another kind of link is no token', async () => {
    const { mails, mailer } = mailbox()
    const app = await setup({}, { url: 'https://site.test', email: { mailer, links: LINKS } })

    await app.browser().call('requestPasswordReset', 'ada@example.com')

    const token = new URL(mails.findLast(mail => mail.kind === 'reset-password')!.url!).searchParams.get('token')!

    expect(await app.browser().call('resetPassword', `${token}.r`, 'a new password long enough')).toMatchObject({ ok: false, error: 'invalid' })
  })
})
