import type { Mail } from '../src/mail'
import { describe, expect, setSystemTime, test } from 'bun:test'
import { Elysia } from 'elysia'
import { browser, testApp, userRecord } from './helpers/app'

const PASSWORD = 'correct horse battery'
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

function from(address: string, agent: string) {
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': address, 'user-agent': agent }, body: '{}' }
}

async function setup(options: Parameters<typeof testApp>[0] = {}) {
  const app = testApp(options)

  await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))

  const signedIn = async (address = '10.0.0.1', agent = FIREFOX) => {
    const browser = app.browser()

    await browser.fetch('/sign-in/u1', from(address, agent))

    return browser
  }

  return { ...app, signedIn }
}

describe('sessions', () => {
  test('the list shows every browser signed in, this one marked, with its device and address', async () => {
    const { signedIn } = await setup()
    const laptop = await signedIn('10.0.0.1', FIREFOX)

    await signedIn('10.0.0.2', IPHONE)

    const sessions = await laptop.call('sessions')

    expect(sessions).toHaveLength(2)
    // Listing from no address of its own moved this one's.
    expect(sessions[0]).toMatchObject({ current: true, ip: 'unknown', userAgent: FIREFOX, device: { browser: 'Firefox', os: 'Windows', mobile: false }, place: null })
    expect(sessions[1]).toMatchObject({ current: false, ip: '10.0.0.2', device: { browser: 'Safari', os: 'iOS', mobile: true } })
  })

  test('ending another session signs that browser out on its next request', async () => {
    const { signedIn } = await setup()
    const laptop = await signedIn()
    const phone = await signedIn('10.0.0.2', IPHONE)
    const [, other] = await laptop.call('sessions')

    expect(await phone.json('/me')).toMatchObject({ id: 'u1' })
    expect(await laptop.call('endSession', other.id)).toBe(true)
    expect(await phone.json('/me')).toBe('anonymous')
    expect(await laptop.json('/me')).toMatchObject({ id: 'u1' })
    expect(await laptop.call('sessions')).toHaveLength(1)
  })

  test('ending this session signs out, and a session of someone else is not ended', async () => {
    const { signedIn, store, browser } = await setup()
    const laptop = await signedIn()
    const [own] = await laptop.call('sessions')

    await store.users.create(userRecord({ id: 'u2' }))
    const bob = browser()

    await bob.fetch('/sign-in/u2', { method: 'POST' })

    expect(await bob.call('endSession', own.id)).toBe(false)
    expect(await laptop.json('/me')).toMatchObject({ id: 'u1' })
    expect(await laptop.call('endSession', own.id)).toBe(true)
    expect(await laptop.json('/me')).toBe('anonymous')
    expect(await store.sessions.get(own.id)).toBeUndefined()
  })

  test('signing out forgets the session, signing in again replaces it', async () => {
    const { signedIn, store } = await setup()
    const laptop = await signedIn()

    await laptop.fetch('/sign-in/u1', { method: 'POST' })
    expect(await store.sessions.listByUser('u1')).toHaveLength(1)

    await laptop.fetch('/sign-out', { method: 'POST' })
    expect(await store.sessions.listByUser('u1')).toEqual([])
  })

  test('signing out everywhere empties the list, or keeps this one only', async () => {
    const { signedIn } = await setup()
    const laptop = await signedIn()
    const phone = await signedIn('10.0.0.2', IPHONE)

    await laptop.fetch('/sign-out-everywhere?keep=1', { method: 'POST' })

    expect(await laptop.call('sessions')).toMatchObject([{ current: true }])
    expect(await phone.json('/me')).toBe('anonymous')
  })

  test('changing the password keeps only this session on the list', async () => {
    const { browser } = await setup()
    const laptop = browser()

    await laptop.call('register', { email: 'bob@example.com', password: PASSWORD })
    const phone = browser()

    await phone.post('/password', { identifier: 'bob@example.com', password: PASSWORD })
    expect(await laptop.call('sessions')).toHaveLength(2)

    expect(await laptop.call('changePassword', { password: PASSWORD }, 'a brand new password')).toMatchObject({ ok: true })
    expect(await laptop.call('sessions')).toMatchObject([{ current: true }])
    expect(await phone.json('/me')).toBe('anonymous')
  })

  test('a session unseen for longer than its lifetime is over, and dropped from the list', async () => {
    const { signedIn, store } = await setup({ sessionMaxAge: 3600 })
    const laptop = await signedIn()
    const phone = await signedIn('10.0.0.2', IPHONE)

    setSystemTime(new Date(Date.now() + 50 * 60 * 1000))
    // Seen again, so its hour starts over.
    expect(await laptop.json('/me')).toMatchObject({ id: 'u1' })
    setSystemTime(new Date(Date.now() + 20 * 60 * 1000))

    try {
      expect(await laptop.call('sessions')).toMatchObject([{ current: true }])
      expect(await store.sessions.listByUser('u1')).toHaveLength(1)
      expect(await phone.json('/me')).toBe('anonymous')
    }
    finally {
      setSystemTime()
    }
  })

  test('a visit from a new address is recorded', async () => {
    const { signedIn, store } = await setup()
    const laptop = await signedIn()

    expect(await store.sessions.listByUser('u1')).toMatchObject([{ ip: '10.0.0.1' }])

    await laptop.fetch('/me', { headers: { 'x-forwarded-for': '10.0.0.9' } })

    expect(await store.sessions.listByUser('u1')).toMatchObject([{ ip: '10.0.0.9' }])
  })

  test('the app\'s locate places each address, and one failing leaves it unplaced', async () => {
    const { signedIn } = await setup({
      locate: (ip) => {
        if (ip === '10.0.0.2')
          throw new Error('down')

        return 'Lyon, France'
      },
    })
    const laptop = await signedIn()

    await signedIn('10.0.0.2', IPHONE)

    expect((await laptop.call('sessions')).map((session: { place: string | null }) => session.place)).toEqual(['Lyon, France', null])
  })

  test('a bearer token sees no sessions and ends none', async () => {
    const { signedIn, app } = await setup()
    const laptop = await signedIn()
    const [own] = await laptop.call('sessions')
    const { token } = await laptop.call('createToken', 'CLI')
    const call = async (method: string, ...args: unknown[]) => (await app.handle(new Request(`http://localhost/call/${method}`, { method: 'POST', headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) }))).json()

    expect(await call('sessions')).toEqual([])
    expect(await call('endSession', own.id)).toBe(false)
    expect(await laptop.json('/me')).toMatchObject({ id: 'u1' })
  })

  test('a sign-in from before sessions were kept goes on the list at its next request', async () => {
    const { auth, store } = await setup()
    const app = new Elysia()
      .use(auth.plugin)
      .post('/legacy', async (ctx) => {
        const { session } = ctx as unknown as { session: { set: (key: string, value: unknown) => Promise<void> } }

        await session.set('auth', { user: 'u1', version: 0, at: Date.now() })

        return 'ok'
      })
      .get('/me', async ({ auth }) => (await auth.user()) ?? 'anonymous')
    const old = browser(app)

    await old.fetch('/legacy', { method: 'POST' })

    expect(await old.json('/me')).toMatchObject({ id: 'u1' })
    expect(await store.sessions.listByUser('u1')).toHaveLength(1)
    expect(await old.json('/me')).toMatchObject({ id: 'u1' })
    expect(await store.sessions.listByUser('u1')).toHaveLength(1)
  })

  test('a new sign-in mail links to the app\'s sessions page', async () => {
    const mails: Mail[] = []
    const { browser } = await setup({
      url: 'https://site.test',
      sessionsPage: '/account/sessions',
      email: { mailer: { send: mail => void mails.push(mail) }, links: { 'verify-email': '/v', 'reset-password': '/r', 'magic-link': '/m', 'change-email': '/c' }, requireVerified: false },
    })
    const bob = browser()

    await bob.call('register', { email: 'bob@example.com', password: PASSWORD })
    await bob.call('verifyEmail', new URL(mails.at(-1)!.url!).searchParams.get('token'))
    await browser().json('/password', { ...from('10.0.0.7', IPHONE), body: JSON.stringify({ identifier: 'bob@example.com', password: PASSWORD }) })

    const notice = mails.find(mail => mail.kind === 'new-sign-in')!

    expect(notice.url).toBe('https://site.test/account/sessions')
    expect(notice.text).toContain('https://site.test/account/sessions')
    expect(notice.html).toContain('href="https://site.test/account/sessions"')
  })
})
