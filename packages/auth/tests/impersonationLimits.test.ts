import type { AuthMailMessage as Mail } from '../src/mail'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const MINUTE = 60_000

afterEach(() => {
  setSystemTime()
})

async function setup() {
  const mails: Mail[] = []
  const app = testApp({
    site: 'https://site.test',
    name: 'Site',
    admin: 'admin',
    email: { mailer: { send: (mail) => {
      mails.push(mail)
    } }, links: { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }, requireVerified: false },
    organizations: { roles: { owner: ['admin'], admin: ['member'], member: [] }, owner: 'owner', manage: 'admin', defaultRoles: ['member'], invitationPage: '/invitation' },
  })
  const person = async (email: string, roles: string[] = []) => {
    const browser = app.browser()
    const { user } = await browser.callHas('user', 'password.register', { email, password: PASSWORD })

    await app.store.users.update(user.id, { emailVerifiedAt: new Date(), roles })

    return { browser, id: user.id }
  }
  const root = await person('root@example.com', ['admin'])
  const ada = await person('ada@example.com')
  const grace = await person('grace@example.com')
  const { membership } = await ada.browser.callOk('organizations.create', { name: 'Acme' })
  const org = membership.organization.id

  return { ...app, mails, person, root, ada, grace, org }
}

describe('an admin acting as a user', () => {
  test('writes nothing to the user\'s organizations, and reads them', async () => {
    const { root, ada, grace, org, person } = await setup()
    const { invitation } = await ada.browser.callOk('organizations.invite', org, 'grace@example.com')

    await grace.browser.callOk('organizations.acceptInvitation', invitation.id)

    const sent = await ada.browser.callOk('organizations.invite', org, 'someone@example.com')
    const bob = await person('bob@example.com')
    const toBob = await ada.browser.callOk('organizations.invite', org, 'bob@example.com')

    await root.browser.callOk('admin.impersonate', ada.id)

    const refused = { ok: false, error: { code: 'impersonating' } }

    expect(await root.browser.call('organizations.create', { name: 'Mine' })).toMatchObject(refused)
    expect(await root.browser.call('organizations.update', org, { name: 'Renamed' })).toMatchObject(refused)
    expect(await root.browser.call('organizations.invite', org, 'new@example.com')).toMatchObject(refused)
    expect(await root.browser.call('organizations.revokeInvitation', org, sent.invitation.id)).toMatchObject(refused)
    expect(await root.browser.call('organizations.setMemberRoles', org, grace.id, ['admin'])).toMatchObject(refused)
    expect(await root.browser.call('organizations.removeMember', org, grace.id)).toMatchObject(refused)
    expect(await root.browser.call('organizations.leave', org)).toMatchObject(refused)
    expect(await root.browser.call('organizations.delete', org)).toMatchObject(refused)

    // Reads stay open.
    expect(await root.browser.call('organizations.list')).toMatchObject([{ organization: { id: org } }])
    expect(await root.browser.call('organizations.members', org)).toMatchObject({ ok: true })
    expect(await root.browser.call('organizations.invitations', org)).toMatchObject({ ok: true })

    await root.browser.call('admin.stopImpersonating')

    expect(await ada.browser.call('organizations.members', org)).toMatchObject({ ok: true, members: [{}, { roles: ['member'] }] })
    expect(await ada.browser.call('organizations.get', org)).toMatchObject({ organization: { name: 'Acme' } })

    // Accepting or declining an invitation is a write of the invited user's too.
    await root.browser.callOk('admin.impersonate', bob.id)
    expect(await root.browser.call('organizations.acceptInvitation', toBob.invitation.id)).toMatchObject(refused)
    expect(await root.browser.call('organizations.rejectInvitation', toBob.invitation.id)).toMatchObject(refused)
    await root.browser.call('admin.stopImpersonating')
    expect(await bob.browser.call('organizations.acceptInvitation', toBob.invitation.id)).toMatchObject({ ok: true })
  })

  test('has a fixed half hour, which activity does not renew', async () => {
    const { root, ada } = await setup()
    const now = Date.now()

    await root.browser.callOk('admin.impersonate', ada.id)
    setSystemTime(new Date(now + 20 * MINUTE))
    expect(await root.browser.json('/me')).toMatchObject({ email: 'ada@example.com' })
    setSystemTime(new Date(now + 31 * MINUTE))
    expect(await root.browser.json('/me')).toBe('anonymous')
  })

  test('tells the person by mail', async () => {
    const { root, ada, mails } = await setup()

    mails.length = 0
    await root.browser.callOk('admin.impersonate', ada.id)
    await Bun.sleep(10)

    expect(mails.map(mail => [mail.kind, mail.to])).toEqual([['impersonation-started', 'ada@example.com']])
  })
})
