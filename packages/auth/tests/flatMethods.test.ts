import { describe, expect, test } from 'bun:test'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'

describe('the flat account methods, deprecated since 1.87', () => {
  test('reach the grouped ones', async () => {
    const { auth, browser } = testApp()
    const made = await auth.createUser({ email: 'ada@example.com', username: 'ada', password: PASSWORD })
    const ada = browser()

    expect(made.ok).toBe(true)
    expect(await auth.admin.createUser({ email: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: false, errors: { email: 'taken' } })
    expect(await ada.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
    expect(await ada.call('changeUsername', 'countess')).toMatchObject({ ok: true, user: { username: 'countess' } })
    expect(await ada.call('listIdentities')).toEqual(await ada.call('oauth.identities'))
    expect(await ada.call('listAuditLog')).toEqual(await ada.call('audit.list'))
    expect(await ada.call('updateLocale', 'fr')).toEqual({ ok: true })
    expect((await ada.call('exportData')).ok).toBe(true)
    expect(await ada.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
  })
})
