import type { AuthEventInfo } from '../src/events'
import type { AuthMailMessage as Mail } from '../src/mail'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const MINUTE = 60_000

afterEach(() => {
  setSystemTime()
})

async function setup(options: { failing?: boolean } = {}) {
  const mails: Mail[] = []
  const events: AuthEventInfo[] = []
  const app = testApp({
    site: 'https://site.test',
    name: 'Site',
    admin: 'admin',
    onEvent: (info) => {
      events.push(info)
    },
    email: { mailer: { send: (mail) => {
      if (options.failing)
        throw new Error('relay down')

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

  return { ...app, mails, events, person, root, ada, grace, org }
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
    expect(await root.browser.json('/me')).toMatchObject({ email: 'root@example.com' })
  })

  test('an expired one puts the admin back as themselves and records that it expired', async () => {
    const { root, ada, events } = await setup()
    const now = Date.now()

    const own = root.browser.cookies.get('kay_local_clear')

    await root.browser.callOk('admin.impersonate', ada.id)
    expect(root.browser.cookies.get('kay_local_clear')).not.toBe(own)
    setSystemTime(new Date(now + 31 * MINUTE))
    expect(await root.browser.json('/me')).toMatchObject({ email: 'root@example.com' })
    // The browser is tagged as the admin again, so a local() mirror filled as the user is emptied.
    expect(root.browser.cookies.get('kay_local_clear')).toBe(own)

    const ended = events.filter(info => info.event === 'impersonation-ended')

    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ user: { email: 'ada@example.com' }, context: { actor: { email: 'root@example.com' } }, expired: true })
    // Once, however many requests follow.
    await root.browser.json('/me')
    expect(events.filter(info => info.event === 'impersonation-ended')).toHaveLength(1)
  })

  test('one ended by hand is not marked expired', async () => {
    const { root, ada, events } = await setup()

    await root.browser.callOk('admin.impersonate', ada.id)
    await root.browser.call('admin.stopImpersonating')

    const ended = events.find(info => info.event === 'impersonation-ended')

    expect(ended).toBeDefined()
    expect(ended).not.toHaveProperty('expired')
  })

  test('goes on when the mailer fails, and sends nothing to an address not verified', async () => {
    const down = await setup({ failing: true })

    await down.root.browser.callOk('admin.impersonate', down.ada.id)
    await Bun.sleep(10)
    expect(await down.root.browser.json('/me')).toMatchObject({ email: 'ada@example.com' })

    const { root, ada, mails, store } = await setup()

    await store.users.update(ada.id, { emailVerifiedAt: null })
    mails.length = 0
    await root.browser.callOk('admin.impersonate', ada.id)
    await Bun.sleep(10)
    expect(mails).toEqual([])
    expect(await root.browser.json('/me')).toMatchObject({ email: 'ada@example.com' })
  })

  test('tells the person by mail', async () => {
    const { root, ada, mails } = await setup()

    mails.length = 0
    await root.browser.callOk('admin.impersonate', ada.id)
    await Bun.sleep(10)

    expect(mails.map(mail => [mail.kind, mail.to])).toEqual([['impersonation-started', 'ada@example.com']])
  })
})
