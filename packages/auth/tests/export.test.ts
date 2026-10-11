import { describe, expect, test } from 'bun:test'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'

describe('exporting a user\'s data', () => {
  test('gives what kayjs-auth keeps about the user, no secret among it, with the app\'s own', async () => {
    const { browser, store } = testApp({ audit: true, onExport: user => ({ posts: [`by ${user.email}`] }) })
    const ada = browser()
    const { user } = await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    await ada.call('createToken', { password: PASSWORD }, 'Phone')
    await store.identities.create({ provider: 'discord', providerId: '42', userId: user.id, accessToken: 'sealed-access', refreshToken: 'sealed-refresh', tokenExpiresAt: null, createdAt: new Date() })

    const exported = await ada.call('exportData')
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
})
