import { describe, expect, test } from 'bun:test'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'

// The names kayjs-auth's methods had before 1.105 work until 1.108: each answers what the method that took its place answers.
describe('the methods under their names before 1.105', () => {
  test('each answers as its replacement does', async () => {
    const { browser: browserOf, store } = testApp({
      admin: 'admin',
      organizations: { roles: { owner: [], member: [] }, owner: 'owner', manage: 'owner', defaultRoles: ['member'] },
    })
    const browser = browserOf()
    const { user } = await browser.callHas('user', 'password.register', { email: 'root@example.com', password: PASSWORD })

    await store.users.update(user.id, { roles: ['admin'] })

    const created = await browser.callOk('organizations.create', { name: 'Acme' })
    const org = created.membership.organization.id
    const pairs: [string, string, unknown[]][] = [
      ['requireAdmin', 'admin.require', []],
      ['admin.roles', 'admin.listRoles', []],
      ['admin.auditLog', 'admin.listAuditLog', []],
      ['organizations.members', 'organizations.listMembers', [org]],
      ['organizations.invitations', 'organizations.listInvitations', [org]],
      ['organizations.myInvitations', 'organizations.listMyInvitations', []],
      ['account.profile', 'account.getProfile', []],
      ['oauth.identities', 'oauth.listIdentities', []],
      ['oauthServer.clients', 'oauthServer.listClients', []],
      ['scopes', 'tokens.scopes', []],
      ['hasScope', 'tokens.hasScope', ['read']],
      ['provedLately', 'proof.recent', []],
      ['captchaRequired', 'captcha.required', ['sign-in']],
      ['captchaChallenge', 'captcha.challenge', ['sign-in']],
      ['oauthOrigin', 'oauthServer.origin', []],
      ['oauthFixed', 'oauthServer.fixed', []],
    ]

    for (const [old, now, args] of pairs) {
      expect(await browser.post(`/call/${old}`, args), old).toEqual(await browser.post(`/call/${now}`, args))
    }

    expect(await browser.call('requireAdmin')).toMatchObject({ id: user.id, email: 'root@example.com' })
  })
})
