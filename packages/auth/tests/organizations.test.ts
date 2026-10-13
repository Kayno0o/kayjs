import type { GuardContext } from 'kay'
import type { User } from '../src/auth'
import type { AuthEvent } from '../src/events'
import type { Mail } from '../src/mail'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Elysia } from 'elysia'
import { browser, testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const ORG_EVENTS = new Set<AuthEvent>(['organization-created', 'organization-deleted', 'member-joined', 'member-left', 'member-removed', 'member-roles-changed'])

afterEach(() => {
  setSystemTime()
})

async function setup(options: { invitationPage?: string | undefined, create?: 'admin' } = {}) {
  const mails: Mail[] = []
  const events: [AuthEvent, string | null, string | undefined, string | undefined][] = []
  const app = testApp({
    url: 'https://site.test',
    site: 'Site',
    email: {
      mailer: {
        send: (mail) => {
          mails.push(mail)
        },
      },
      links: { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' },
      requireVerified: false,
    },
    organizations: {
      roles: { owner: ['admin'], admin: ['member'], member: [] },
      owner: 'owner',
      manage: 'admin',
      defaultRoles: ['member'],
      invitationPage: '/invitation',
      ...options,
    },
    onEvent: (event, user: User, detail, context) => {
      if (ORG_EVENTS.has(event))
        events.push([event, user.email, detail, context.actor?.email ?? undefined])
    },
  })
  const site = new Elysia()
    .use(app.app)
    .use(new Elysia().use(app.auth.gate()).get('/orgs/:org/settings', () => 'ok', { auth: app.auth.memberOf('admin') }).get('/orgs/:org', () => 'ok', { auth: app.auth.memberOf() }))
    // Runs the guard as kay would, with the route's params or, as kay does today, without.
    .get('/guarded/:org', async ({ auth, request, params, query }) => {
      const ctx = { request, url: new URL(request.url), locals: { auth }, ...query.params === '1' ? { params } : {}, deny: (status = 403) => {
        throw new Error(`denied ${status}`)
      } } as unknown as GuardContext

      try {
        await app.auth.guard({ require: app.auth.memberOf('admin') })(ctx)

        return 'ok'
      }
      catch (error) {
        return (error as Error).message
      }
    })

  const person = async (email: string, verified = true) => {
    const visitor = browser(site)
    const { user } = await visitor.call('register', { email, password: PASSWORD })

    if (verified)
      await app.store.users.update(user.id, { emailVerifiedAt: new Date() })

    return { browser: visitor, id: user.id as string }
  }
  const ada = await person('ada@example.com')

  if (options.create)
    await app.store.users.update(ada.id, { roles: [options.create] })

  const { membership } = await ada.browser.call('createOrganization', { name: ' Acme ', slug: 'Acme' })
  const org = membership.organization.id as string
  // An invitation of `email` sent by `from`, accepted by `to`.
  const join = async (from: { browser: ReturnType<typeof browser> }, to: { browser: ReturnType<typeof browser> }, email: string, roles?: string[]) => {
    const { invitation } = await from.browser.call('invite', org, email, ...roles === undefined ? [] : [roles])

    return to.browser.call('acceptInvitation', invitation.id)
  }

  return { ...app, site, mails, events, person, ada, org, join }
}

describe('organizations', () => {
  test('a user creates one, owning it, and finds it by id or slug with their roles', async () => {
    const { ada, org, person } = await setup()

    expect(await ada.browser.call('organization', 'acme')).toMatchObject({ organization: { id: org, name: 'Acme', slug: 'acme' }, roles: ['owner'] })
    expect(await ada.browser.call('organizations')).toMatchObject([{ organization: { id: org }, roles: ['owner'] }])
    expect(await ada.browser.call('isMember', 'acme', 'member')).toBe(true)
    expect(await ada.browser.call('createOrganization', { name: 'Again', slug: 'acme' })).toEqual({ ok: false, error: 'slug-taken' })
    expect(await ada.browser.call('createOrganization', { name: 'Bad', slug: 'no spaces' })).toEqual({ ok: false, error: 'invalid-slug' })
    expect(await ada.browser.call('createOrganization', { name: '  ' })).toEqual({ ok: false, error: 'invalid-name' })

    const grace = await person('grace@example.com')

    // Someone else's organization reads as missing.
    expect(await grace.browser.call('organization', 'acme')).toBeFalsy()
    expect(await grace.browser.call('members', org)).toEqual({ ok: false, error: 'not-found' })
  })

  test('`create` limits who may create one', async () => {
    const { person } = await setup({ create: 'admin' })
    const grace = await person('grace@example.com')

    expect(await grace.browser.call('createOrganization', { name: 'Mine' })).toEqual({ ok: false, error: 'forbidden' })
  })

  test('an invitation mails a link only the invited address accepts, verified, once', async () => {
    const { ada, org, mails, person, store } = await setup()
    const grace = await person('grace@example.com', false)
    const alan = await person('alan@example.com')
    const { invitation } = await ada.browser.call('invite', org, 'Grace@Example.com')

    expect(invitation).toMatchObject({ email: 'grace@example.com', roles: ['member'], invitedBy: ada.id, organization: { name: 'Acme' } })
    expect(mails.at(-1)).toMatchObject({ kind: 'invitation', site: 'Site', detail: 'Acme', to: 'grace@example.com', url: `https://site.test/invitation?invitation=${invitation.id}`, subject: 'Join Acme on Site' })
    expect(await alan.browser.call('invitation', invitation.id)).toMatchObject({ email: 'grace@example.com', organization: { name: 'Acme' } })
    expect(await alan.browser.call('acceptInvitation', invitation.id)).toEqual({ ok: false, error: 'wrong-account' })
    expect(await grace.browser.call('myInvitations')).toEqual([])
    expect(await grace.browser.call('acceptInvitation', invitation.id)).toEqual({ ok: false, error: 'unverified' })

    await store.users.update(grace.id, { emailVerifiedAt: new Date() })

    expect(await grace.browser.call('acceptInvitation', invitation.id)).toMatchObject({ ok: true, membership: { roles: ['member'] } })
  })

  test('only a manager with a verified address invites, and one address is invited 5 times a day at most, whoever invites it', async () => {
    const { ada, org, mails, person } = await setup()
    const mallory = await person('mallory@example.com', false)
    const grace = await person('grace@example.com')
    const theirs = (await mallory.browser.call('createOrganization', { name: 'Support' })).membership.organization.id
    const other = (await grace.browser.call('createOrganization', { name: 'Other' })).membership.organization.id
    const sent = mails.length

    expect(await mallory.browser.call('invite', theirs, 'joan@example.com')).toEqual({ ok: false, error: 'unverified' })
    expect(mails).toHaveLength(sent)

    for (let i = 0; i < 5; i++)
      expect(await ada.browser.call('invite', org, 'joan@example.com')).toMatchObject({ ok: true })

    expect(await ada.browser.call('invite', org, 'Joan@Example.com')).toEqual({ ok: false, error: 'limited' })
    expect(await grace.browser.call('invite', other, 'joan@example.com')).toEqual({ ok: false, error: 'limited' })
    expect(await grace.browser.call('invite', other, 'alan@example.com')).toMatchObject({ ok: true })
    expect(mails).toHaveLength(sent + 6)
  })

  test('an organization\'s name refuses control characters, line breaks and direction overrides', async () => {
    const { ada, org } = await setup()

    for (const name of ['Acme\nYour account is locked', 'Acme\r\nBcc: x', 'Acme\tInc', 'Acme\u0000', 'Acme\u2028Inc', '\u202Emoc.live'])
      expect(await ada.browser.call('createOrganization', { name })).toEqual({ ok: false, error: 'invalid-name' })

    expect(await ada.browser.call('updateOrganization', org, { name: 'Acme\nInc' })).toEqual({ ok: false, error: 'invalid-name' })
    expect(await ada.browser.call('createOrganization', { name: 'Ünïcode Acme 東京 🚀' })).toMatchObject({ ok: true })
  })

  test('the invited user sees their invitations, accepts one, and joins with its roles', async () => {
    const { ada, org, person, store, events } = await setup()
    const grace = await person('grace@example.com')
    const { invitation } = await ada.browser.call('invite', org, 'grace@example.com', ['admin'])

    expect(await grace.browser.call('myInvitations')).toMatchObject([{ id: invitation.id, roles: ['admin'] }])
    expect(await grace.browser.call('acceptInvitation', invitation.id)).toMatchObject({ ok: true, membership: { organization: { id: org }, roles: ['admin'] } })
    expect(await grace.browser.call('acceptInvitation', invitation.id)).toEqual({ ok: false, error: 'not-found' })
    expect(await grace.browser.call('invitation', invitation.id)).toBeFalsy()
    expect(await ada.browser.call('invite', org, 'grace@example.com')).toEqual({ ok: false, error: 'member' })
    expect((await ada.browser.call('members', org)).members).toMatchObject([{ user: { email: 'ada@example.com' }, roles: ['owner'] }, { user: { id: grace.id }, roles: ['admin'] }])
    expect(await store.members!.get(org, grace.id)).toMatchObject({ roles: ['admin'] })
    expect(events.at(-1)).toEqual(['member-joined', 'grace@example.com', `${org} admin`, undefined])
  })

  test('invitations are listed for managers, replaced when sent again, revoked, declined and expire', async () => {
    const { ada, org, person } = await setup()
    const grace = await person('grace@example.com')
    const first = (await ada.browser.call('invite', org, 'grace@example.com')).invitation
    const second = (await ada.browser.call('invite', org, 'grace@example.com')).invitation

    expect((await ada.browser.call('invitations', org)).invitations.map((invitation: { id: string }) => invitation.id)).toEqual([second.id])
    expect(await grace.browser.call('invitation', first.id)).toBeFalsy()
    expect(await grace.browser.call('invitations', org)).toEqual({ ok: false, error: 'not-found' })
    expect(await ada.browser.call('revokeInvitation', org, second.id)).toEqual({ ok: true })
    expect(await grace.browser.call('acceptInvitation', second.id)).toEqual({ ok: false, error: 'not-found' })

    const third = (await ada.browser.call('invite', org, 'grace@example.com')).invitation

    expect(await grace.browser.call('declineInvitation', third.id)).toBe(true)

    const fourth = (await ada.browser.call('invite', org, 'grace@example.com')).invitation

    setSystemTime(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000))

    expect(await grace.browser.call('acceptInvitation', fourth.id)).toEqual({ ok: false, error: 'not-found' })
    expect((await ada.browser.call('invitations', org)).invitations).toEqual([])
  })

  test('a manager gives only roles they hold, to members holding none above theirs, and the last owner stays', async () => {
    const { ada, org, person, join, events } = await setup()
    const grace = await person('grace@example.com')
    const alan = await person('alan@example.com')

    await join(ada, grace, 'grace@example.com', ['admin'])
    await join(ada, alan, 'alan@example.com')

    expect(await grace.browser.call('invite', org, 'joan@example.com', ['owner'])).toEqual({ ok: false, error: 'forbidden' })
    expect(await grace.browser.call('setMemberRoles', org, alan.id, ['owner'])).toEqual({ ok: false, error: 'forbidden' })
    expect(await grace.browser.call('setMemberRoles', org, ada.id, ['member'])).toEqual({ ok: false, error: 'forbidden' })
    expect(await grace.browser.call('removeMember', org, ada.id)).toEqual({ ok: false, error: 'forbidden' })
    expect(await grace.browser.call('setMemberRoles', org, alan.id, ['nope'])).toEqual({ ok: false, error: 'unknown-role' })
    expect(await alan.browser.call('removeMember', org, grace.id)).toEqual({ ok: false, error: 'forbidden' })
    expect(await grace.browser.call('setMemberRoles', org, alan.id, ['admin'])).toEqual({ ok: true })
    expect(await grace.browser.call('removeMember', org, alan.id)).toEqual({ ok: true })

    expect(await ada.browser.call('leaveOrganization', org)).toEqual({ ok: false, error: 'last-owner' })
    expect(await ada.browser.call('setMemberRoles', org, ada.id, ['admin'])).toEqual({ ok: false, error: 'last-owner' })
    expect(await ada.browser.call('setMemberRoles', org, grace.id, ['owner'])).toEqual({ ok: true })
    expect(await ada.browser.call('leaveOrganization', org)).toEqual({ ok: true })
    expect(await grace.browser.call('removeMember', org, grace.id)).toEqual({ ok: false, error: 'last-owner' })

    expect(events.filter(([event]) => event !== 'member-joined')).toEqual([
      ['organization-created', 'ada@example.com', org, undefined],
      ['member-roles-changed', 'alan@example.com', `${org} admin`, 'grace@example.com'],
      ['member-removed', 'alan@example.com', org, 'grace@example.com'],
      ['member-roles-changed', 'grace@example.com', `${org} owner`, 'ada@example.com'],
      ['member-left', 'ada@example.com', org, undefined],
    ])
  })

  test('managers rename it and change its slug, and owners alone delete it with its memberships', async () => {
    const { ada, org, person, join, store } = await setup()
    const grace = await person('grace@example.com')

    await join(ada, grace, 'grace@example.com', ['admin'])
    await ada.browser.call('createOrganization', { name: 'Other', slug: 'other' })

    expect(await grace.browser.call('updateOrganization', org, { name: 'Acme Inc', slug: 'acme-inc' })).toMatchObject({ ok: true, organization: { name: 'Acme Inc', slug: 'acme-inc' } })
    expect(await grace.browser.call('updateOrganization', org, { slug: 'other' })).toEqual({ ok: false, error: 'slug-taken' })
    expect(await grace.browser.call('updateOrganization', 'acme-inc', { slug: null })).toMatchObject({ ok: true, organization: { slug: null } })
    expect(await grace.browser.call('deleteOrganization', org)).toEqual({ ok: false, error: 'forbidden' })
    expect(await ada.browser.call('deleteOrganization', org)).toEqual({ ok: true })
    expect(await store.members!.listByUser(grace.id)).toEqual([])
    expect((await ada.browser.call('organizations')).map((found: { organization: { slug: string } }) => found.organization.slug)).toEqual(['other'])
  })

  test('deleting a user takes their memberships, and the export lists them', async () => {
    const { ada, org, person, join, store } = await setup()
    const grace = await person('grace@example.com')

    await join(ada, grace, 'grace@example.com')

    expect((await grace.browser.call('exportData')).data.organizations).toMatchObject([{ organization: { id: org }, roles: ['member'] }])
    expect(await grace.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
    expect(await store.members!.listByOrganization(org)).toHaveLength(1)
  })

  test('deleting a user takes the invitations to their address', async () => {
    const { ada, org, person, store } = await setup()
    const grace = await person('grace@example.com')

    await ada.browser.call('invite', org, 'grace@example.com')
    await ada.browser.call('invite', org, 'alan@example.com')

    expect(await grace.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
    expect(await store.invitations!.listByEmail('grace@example.com')).toEqual([])
    expect(await store.invitations!.listByEmail('alan@example.com')).toHaveLength(1)
  })

  test('a gate and a guard let through members holding the role in the organization the route names, and a guard without params refuses', async () => {
    const { ada, org, person, join, site } = await setup()
    const grace = await person('grace@example.com')
    const alan = await person('alan@example.com')

    await join(ada, grace, 'grace@example.com', ['admin'])

    const status = async (who: { browser: ReturnType<typeof browser> }, path: string) => (await who.browser.fetch(path)).status

    expect(await status(grace, '/orgs/acme/settings')).toBe(200)
    expect(await status(grace, `/orgs/${org}`)).toBe(200)
    expect(await status(alan, '/orgs/acme')).toBe(403)
    expect(await status({ browser: browser(site) }, '/orgs/acme')).toBe(401)
    expect(await status(grace, '/orgs/missing/settings')).toBe(403)
    expect(await grace.browser.json('/guarded/acme?params=1')).toBe('ok')
    expect(await alan.browser.json('/guarded/acme?params=1')).toBe('denied 403')
    expect(await grace.browser.json('/guarded/acme')).toBe('denied 403')
  })

  test('inviting needs the invitation page', async () => {
    const { ada, org } = await setup({ invitationPage: undefined })

    expect(await ada.browser.call('invite', org, 'grace@example.com')).toEqual({ ok: false, error: 'unavailable' })
  })
})
