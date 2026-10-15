import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { totpCode, totpStep } from '../src/totp'
import { testApp, userRecord } from './helpers/app'

const PASSWORD = 'correct horse battery'
const LATER = 11 * 60_000

afterEach(() => {
  setSystemTime()
})

describe('exporting a user\'s data', () => {
  test('gives what kayjs-auth keeps about the user, no secret among it, with the app\'s own', async () => {
    const { browser, store } = testApp({ audit: true, onExport: user => ({ posts: [`by ${user.email}`] }) })
    const ada = browser()
    const { user } = await ada.callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })

    await ada.call('createToken', { password: PASSWORD }, 'Phone')
    await store.identities.create({ provider: 'discord', providerId: '42', userId: user.id, accessToken: 'sealed-access', refreshToken: 'sealed-refresh', tokenExpiresAt: null, createdAt: new Date() })

    const exported = await ada.callOk('exportData')
    const text = JSON.stringify(exported)

    expect(exported).toMatchObject({
      ok: true,
      data: {
        user: { id: user.id, email: 'ada@example.com', hasPassword: true, twoFactorEnabledAt: null },
        identities: [{ provider: 'discord', providerId: '42' }],
        sessions: [{ current: true }],
        passkeys: [],
        tokens: [{ label: 'Phone' }],
        recoveryCodesLeft: 0,
        app: { posts: ['by ada@example.com'] },
      },
    })
    expect(exported.data.audit.map((entry: { event: string }) => entry.event)).toContain('signed-in')

    for (const secret of ['passwordHash', 'sealed-access', 'sealed-refresh', 'digest', 'totpSecret', (await store.users.get(user.id))!.passwordHash!])
      expect(text).not.toContain(secret)
  })

  test('needs a session', async () => {
    const { browser } = testApp()

    expect(await browser().call('exportData')).toEqual({ ok: false, error: 'signed-out' })
  })

  test('counts each export, the download included, against the account\'s limit', async () => {
    const { browser } = testApp({ limits: { export: { max: 2, window: 3600 } } })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect((await ada.call('exportData')).ok).toBe(true)
    expect((await ada.fetch('/auth/export')).status).toBe(200)
    expect(await ada.call('exportData')).toEqual({ ok: false, error: 'limited' })
    expect((await ada.fetch('/auth/export')).status).toBe(429)
  })

  describe('needs a sign-in or a proof under ten minutes old, so a stolen session downloads nothing', () => {
    test('a stale session is refused by the method and the route, neither counting against the limit', async () => {
      const { browser } = testApp({ limits: { export: { max: 1, window: 3600 } } })
      const ada = browser()

      await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
      setSystemTime(new Date(Date.now() + LATER))

      expect(await ada.call('exportData')).toEqual({ ok: false, error: 'stale' })

      const response = await ada.fetch('/auth/export')

      expect(response.status).toBe(403)
      expect(response.headers.get('content-disposition')).toBeNull()

      await ada.call('reprove', { password: PASSWORD })

      expect((await ada.call('exportData')).ok).toBe(true)
    })

    test('a wrong proof leaves it refused, a right one opens the route again', async () => {
      const { browser } = testApp()
      const ada = browser()

      await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
      setSystemTime(new Date(Date.now() + LATER))

      expect(await ada.call('reprove', { password: 'wrong password' })).toEqual({ ok: false, error: 'proof' })
      expect((await ada.fetch('/auth/export')).status).toBe(403)
      expect(await ada.call('provedLately')).toBe(false)

      await ada.call('reprove', { password: PASSWORD })

      expect(await ada.call('provedLately')).toBe(true)
      expect((await ada.fetch('/auth/export')).status).toBe(200)
    })

    test('an account with neither a password nor a second factor can only sign in again', async () => {
      const { browser, store } = testApp()
      const ada = browser()

      await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
      await ada.fetch('/sign-in/u1', { method: 'POST' })

      expect((await ada.call('exportData')).ok).toBe(true)
      setSystemTime(new Date(Date.now() + LATER))

      expect(await ada.call('exportData')).toEqual({ ok: false, error: 'stale' })
      expect(await ada.call('reprove', {})).toEqual({ ok: false, error: 'stale' })
      expect((await ada.fetch('/auth/export')).status).toBe(403)
    })

    test('an account with a second factor stays refused after a wrong code, and opens again once proved', async () => {
      const { browser } = testApp()
      const ada = browser()

      await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

      const { setup } = await ada.callOk('setUpTwoFactor', { password: PASSWORD })

      await ada.call('enableTwoFactor', await totpCode(setup.secret, totpStep()))
      setSystemTime(new Date(Date.now() + LATER))

      expect(await ada.call('exportData')).toEqual({ ok: false, error: 'stale' })
      expect(await ada.call('reprove', { code: '000000' })).toEqual({ ok: false, error: 'proof' })
      expect(await ada.call('exportData')).toEqual({ ok: false, error: 'stale' })

      await ada.call('reprove', { password: PASSWORD })

      expect((await ada.call('exportData')).ok).toBe(true)
    })

    test('a signed-out visitor still gets signed-out, not stale', async () => {
      const { browser } = testApp()

      setSystemTime(new Date(Date.now() + LATER))

      expect(await browser().call('exportData')).toEqual({ ok: false, error: 'signed-out' })
    })
  })
})
