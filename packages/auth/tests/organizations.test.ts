import type { Duration, GuardContext } from 'kay'
import type { AuthEvent, AuthEventInfo } from '../src/events'
import type { AuthMailMessage as Mail } from '../src/mail'
import type { TestBrowser } from './helpers/app'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Elysia } from 'elysia'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const ORG_EVENTS = new Set<AuthEvent>(['organization-created', 'organization-deleted', 'member-joined', 'member-left', 'member-removed', 'member-roles-changed'])

afterEach(() => {
  setSystemTime()
})

async function setup(options: { invitationPage?: string | undefined, create?: 'admin', invitations?: { maxAge: Duration } } = {}, extra: { onDelete?: () => Promise<void> } = {}) {
  const mails: Mail[] = []
  // What `onAuthEvent` hears of the same events: the event, who it happened to, its fields and who acted.
  const heard: [AuthEvent, string | null, object, string | undefined][] = []
  const app = testApp({
    site: 'https://site.test',
    name: 'Site',
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
    ...extra,
    onAuthEvent: ({ event, user, context, ...fields }: AuthEventInfo) => {
      if (ORG_EVENTS.has(event))
        heard.push([event, user.email, fields, context.actor?.email ?? undefined])
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
    const visitor = app.browserOn(site)
    const { user } = await visitor.callHas('user', 'password.register', { email, password: PASSWORD })

    if (verified)
      await app.store.users.update(user.id, { emailVerifiedAt: new Date() })

    return { browser: visitor, id: user.id }
  }
  const ada = await person('ada@example.com')

  if (options.create)
    await app.store.users.update(ada.id, { roles: [options.create] })

  const { membership } = await ada.browser.callOk('organizations.create', { name: ' Acme ', slug: 'Acme' })
  const org = membership.organization.id
  // An invitation of `email` sent by `from`, accepted by `to`.
  const join = async (from: { browser: TestBrowser }, to: { browser: TestBrowser }, email: string, roles?: string[]) => {
    const { invitation } = await from.browser.callOk('organizations.invite', org, email, ...roles === undefined ? [] : [roles])

    return to.browser.call('organizations.acceptInvitation', invitation.id)
  }

  return { ...app, site, mails, heard, person, ada, org, join }
}

describe('organizations', () => {
  test('a user creates one, owning it, and finds it by id or slug with their roles', async () => {
    const { ada, org, person } = await setup()

    expect(await ada.browser.call('organizations.get', 'acme')).toMatchObject({ organization: { id: org, name: 'Acme', slug: 'acme' }, roles: ['owner'] })
    expect(await ada.browser.call('organizations.list')).toMatchObject([{ organization: { id: org }, roles: ['owner'] }])
    expect(await ada.browser.call('organizations.isMember', 'acme', 'member')).toBe(true)
    expect(await ada.browser.call('organizations.create', { name: 'Again', slug: 'acme' })).toEqual({ ok: false, error: 'slug-taken' })
    expect(await ada.browser.call('organizations.create', { name: 'Bad', slug: 'no spaces' })).toEqual({ ok: false, error: 'invalid-slug' })
    expect(await ada.browser.call('organizations.create', { name: '  ' })).toEqual({ ok: false, error: 'invalid-name' })
    expect(await ada.browser.call('organizations.create', { name: 'Blank', slug: '  ' })).toMatchObject({ ok: true, membership: { organization: { name: 'Blank', slug: null } } })

    const grace = await person('grace@example.com')

    // Someone else's organization reads as missing.
    expect(await grace.browser.call('organizations.get', 'acme')).toBeFalsy()
    expect(await grace.browser.call('organizations.members', org)).toEqual({ ok: false, error: 'not-found' })
  })

  test('creating organizations is rate limited per account', async () => {
    const { person } = await setup()
    const grace = await person('grace@example.com')

    for (let made = 0; made < 10; made++)
      expect(await grace.browser.call('organizations.create', { name: `Org ${made}` })).toMatchObject({ ok: true })

    expect(await grace.browser.call('organizations.create', { name: 'One more' })).toEqual({ ok: false, error: 'limited' })
  })

  test('`create` limits who may create one', async () => {
    const { person } = await setup({ create: 'admin' })
    const grace = await person('grace@example.com')

    expect(await grace.browser.call('organizations.create', { name: 'Mine' })).toEqual({ ok: false, error: 'forbidden' })
  })

  test('an invitation mails a link only the invited address accepts, verified, once', async () => {
    const { ada, org, mails, person, store } = await setup()
    const grace = await person('grace@example.com', false)
    const alan = await person('alan@example.com')
    const { invitation } = await ada.browser.callOk('organizations.invite', org, 'Grace@Example.com')

    expect(invitation).toMatchObject({ email: 'grace@example.com', roles: ['member'], invitedBy: ada.id, organization: { name: 'Acme' } })
    expect(mails.at(-1)).toMatchObject({ kind: 'invitation', name: 'Site', detail: 'Acme', to: 'grace@example.com', url: `https://site.test/invitation?invitation=${invitation.id}`, subject: 'Join Acme on Site' })
    expect(await alan.browser.call('organizations.invitation', invitation.id)).toMatchObject({ email: 'grace@example.com', organization: { name: 'Acme' } })
    expect(await alan.browser.call('organizations.acceptInvitation', invitation.id)).toEqual({ ok: false, error: 'wrong-account' })
    expect(await grace.browser.call('organizations.myInvitations')).toEqual([])
    expect(await grace.browser.call('organizations.acceptInvitation', invitation.id)).toEqual({ ok: false, error: 'unverified' })

    await store.users.update(grace.id, { emailVerifiedAt: new Date() })

    expect(await grace.browser.call('organizations.acceptInvitation', invitation.id)).toMatchObject({ ok: true, membership: { roles: ['member'] } })
  })

  test('only a manager with a verified address invites, and one address is invited 5 times a day at most, whoever invites it', async () => {
    const { ada, org, mails, person } = await setup()
    const mallory = await person('mallory@example.com', false)
    const grace = await person('grace@example.com')
    const theirs = (await mallory.browser.callOk('organizations.create', { name: 'Support' })).membership.organization.id
    const other = (await grace.browser.callOk('organizations.create', { name: 'Other' })).membership.organization.id
    const sent = mails.length

    expect(await mallory.browser.call('organizations.invite', theirs, 'joan@example.com')).toEqual({ ok: false, error: 'unverified' })
    expect(mails).toHaveLength(sent)

    for (let i = 0; i < 5; i++)
      expect(await ada.browser.call('organizations.invite', org, 'joan@example.com')).toMatchObject({ ok: true })

    expect(await ada.browser.call('organizations.invite', org, 'Joan@Example.com')).toEqual({ ok: false, error: 'limited' })
    expect(await grace.browser.call('organizations.invite', other, 'joan@example.com')).toEqual({ ok: false, error: 'limited' })
    expect(await grace.browser.call('organizations.invite', other, 'alan@example.com')).toMatchObject({ ok: true })
    expect(mails).toHaveLength(sent + 6)
  })

  test('an organization\'s name refuses control characters, line breaks and direction overrides', async () => {
    const { ada, org } = await setup()

    for (const name of ['Acme\nYour account is locked', 'Acme\r\nBcc: x', 'Acme\tInc', 'Acme\u0000', 'Acme\u2028Inc', '\u202Emoc.live'])
      expect(await ada.browser.call('organizations.create', { name })).toEqual({ ok: false, error: 'invalid-name' })

    expect(await ada.browser.call('organizations.update', org, { name: 'Acme\nInc' })).toEqual({ ok: false, error: 'invalid-name' })
    expect(await ada.browser.call('organizations.create', { name: 'Ünïcode Acme 東京 🚀' })).toMatchObject({ ok: true })
  })

  test('the invited user sees their invitations, accepts one, and joins with its roles', async () => {
    const { ada, org, person, store, heard } = await setup()
    const grace = await person('grace@example.com')
    const { invitation } = await ada.browser.callOk('organizations.invite', org, 'grace@example.com', ['admin'])

    expect(await grace.browser.call('organizations.myInvitations')).toMatchObject([{ id: invitation.id, roles: ['admin'] }])
    expect(await grace.browser.call('organizations.acceptInvitation', invitation.id)).toMatchObject({ ok: true, membership: { organization: { id: org }, roles: ['admin'] } })
    expect(await grace.browser.call('organizations.acceptInvitation', invitation.id)).toEqual({ ok: false, error: 'not-found' })
    expect(await grace.browser.call('organizations.invitation', invitation.id)).toBeFalsy()
    expect(await ada.browser.call('organizations.invite', org, 'grace@example.com')).toEqual({ ok: false, error: 'member' })
    expect((await ada.browser.callOk('organizations.members', org)).members).toMatchObject([{ user: { email: 'ada@example.com' }, roles: ['owner'] }, { user: { id: grace.id }, roles: ['admin'] }])
    expect(await store.members!.get(org, grace.id)).toMatchObject({ roles: ['admin'] })
    expect(heard.at(-1)).toEqual(['member-joined', 'grace@example.com', { organizationId: org, roles: ['admin'] }, undefined])
  })

  test('invitations.maxAge takes a duration string, and a bad one fails naming the option', async () => {
    for (const maxAge of ['2d' as const]) {
      const { ada, org } = await setup({ invitations: { maxAge } })
      const { invitation } = await ada.browser.callOk('organizations.invite', org, 'grace@example.com')

      expect(new Date(invitation.expiresAt).getTime() - Date.now()).toBeGreaterThan(2 * 24 * 60 * 60 * 1000 - 60_000)
      expect(new Date(invitation.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(2 * 24 * 60 * 60 * 1000)
    }

    await expect(setup({ invitations: { maxAge: 'soon' as Duration } })).rejects.toThrow('kay: organizations.invitations.maxAge is \'soon\'')
  })

  test('invitations are listed for managers, replaced when sent again, revoked, declined and expire', async () => {
    const { ada, org, person } = await setup()
    const grace = await person('grace@example.com')
    const first = (await ada.browser.callOk('organizations.invite', org, 'grace@example.com')).invitation
    const second = (await ada.browser.callOk('organizations.invite', org, 'grace@example.com')).invitation

    expect((await ada.browser.callOk('organizations.invitations', org)).invitations.map((invitation: { id: string }) => invitation.id)).toEqual([second.id])
    expect(await grace.browser.call('organizations.invitation', first.id)).toBeFalsy()
    expect(await grace.browser.call('organizations.invitations', org)).toEqual({ ok: false, error: 'not-found' })
    expect(await ada.browser.call('organizations.revokeInvitation', org, second.id)).toEqual({ ok: true })
    expect(await grace.browser.call('organizations.acceptInvitation', second.id)).toEqual({ ok: false, error: 'not-found' })

    const third = (await ada.browser.callOk('organizations.invite', org, 'grace@example.com')).invitation

    expect(await grace.browser.call('organizations.rejectInvitation', third.id)).toEqual({ ok: true })

    const fourth = (await ada.browser.callOk('organizations.invite', org, 'grace@example.com')).invitation

    setSystemTime(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000))

    expect(await grace.browser.call('organizations.acceptInvitation', fourth.id)).toEqual({ ok: false, error: 'not-found' })
    expect((await ada.browser.callOk('organizations.invitations', org)).invitations).toEqual([])
  })

  describe('an invitation stands only while its sender may still grant it', () => {
    async function sentByBob() {
      const context = await setup()
      const { ada, org, person } = context
      const bob = await person('bob@example.com')
      const grace = await person('grace@example.com')

      await context.join(ada, bob, 'bob@example.com', ['admin'])

      const { invitation } = await bob.browser.callOk('organizations.invite', org, 'grace@example.com', ['admin'])

      return { ...context, bob, grace, invitation }
    }

    test('is accepted while the sender still manages the organization', async () => {
      const { grace, invitation } = await sentByBob()

      expect(await grace.browser.call('organizations.acceptInvitation', invitation.id)).toMatchObject({ ok: true, membership: { roles: ['admin'] } })
    })

    test('is dead once the sender is removed', async () => {
      const { ada, bob, grace, invitation, org } = await sentByBob()

      expect(await ada.browser.call('organizations.removeMember', org, bob.id)).toEqual({ ok: true })
      expect(await grace.browser.call('organizations.invitation', invitation.id)).toBeFalsy()
      expect(await grace.browser.call('organizations.myInvitations')).toEqual([])
      expect(await grace.browser.call('organizations.acceptInvitation', invitation.id)).toEqual({ ok: false, error: 'not-found' })
    })

    test('is dead once the sender left', async () => {
      const { bob, grace, invitation, org } = await sentByBob()

      expect(await bob.browser.call('organizations.leave', org)).toEqual({ ok: true })
      expect(await grace.browser.call('organizations.acceptInvitation', invitation.id)).toEqual({ ok: false, error: 'not-found' })
    })

    test('is dead once the sender no longer holds the roles it gives or manages the organization', async () => {
      const { ada, bob, grace, invitation, org } = await sentByBob()

      expect(await ada.browser.call('organizations.setMemberRoles', org, bob.id, ['member'])).toEqual({ ok: true })
      expect(await grace.browser.call('organizations.acceptInvitation', invitation.id)).toEqual({ ok: false, error: 'not-found' })
    })

    test('is dead once the sender\'s account is deleted, even after they were removed first', async () => {
      const { ada, bob, grace, invitation, org, store } = await sentByBob()

      expect(await ada.browser.call('organizations.removeMember', org, bob.id)).toEqual({ ok: true })
      expect(await bob.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
      expect((await store.invitations?.get(invitation.id))?.invitedBy).toBeNull()
      expect(await grace.browser.call('organizations.acceptInvitation', invitation.id)).toEqual({ ok: false, error: 'not-found' })
    })

    test('is dead when its sender deletes their account while a member, and listed to managers only while it stands', async () => {
      const { ada, bob, grace, invitation, org } = await sentByBob()

      expect((await ada.browser.callOk('organizations.invitations', org)).invitations).toHaveLength(1)
      expect(await bob.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
      expect((await ada.browser.callOk('organizations.invitations', org)).invitations).toEqual([])
      expect(await grace.browser.call('organizations.acceptInvitation', invitation.id)).toEqual({ ok: false, error: 'not-found' })
    })
  })

  test('a manager gives only roles they hold, to members holding none above theirs, and the last owner stays', async () => {
    const { ada, org, person, join, heard } = await setup()
    const grace = await person('grace@example.com')
    const alan = await person('alan@example.com')

    await join(ada, grace, 'grace@example.com', ['admin'])
    await join(ada, alan, 'alan@example.com')

    expect(await grace.browser.call('organizations.invite', org, 'joan@example.com', ['owner'])).toEqual({ ok: false, error: 'forbidden' })
    expect(await grace.browser.call('organizations.setMemberRoles', org, alan.id, ['owner'])).toEqual({ ok: false, error: 'forbidden' })
    expect(await grace.browser.call('organizations.setMemberRoles', org, ada.id, ['member'])).toEqual({ ok: false, error: 'forbidden' })
    expect(await grace.browser.call('organizations.removeMember', org, ada.id)).toEqual({ ok: false, error: 'forbidden' })
    expect(await grace.browser.post('/call/organizations.setMemberRoles', [org, alan.id, ['nope']])).toEqual({ ok: false, error: 'unknown-role' })
    expect(await alan.browser.call('organizations.removeMember', org, grace.id)).toEqual({ ok: false, error: 'forbidden' })
    expect(await grace.browser.call('organizations.setMemberRoles', org, alan.id, ['admin'])).toEqual({ ok: true })
    expect(await grace.browser.call('organizations.removeMember', org, alan.id)).toEqual({ ok: true })

    expect(await ada.browser.call('organizations.leave', org)).toEqual({ ok: false, error: 'last-owner' })
    expect(await ada.browser.call('organizations.setMemberRoles', org, ada.id, ['admin'])).toEqual({ ok: false, error: 'last-owner' })
    expect(await ada.browser.call('organizations.setMemberRoles', org, grace.id, ['owner'])).toEqual({ ok: true })
    expect(await ada.browser.call('organizations.leave', org)).toEqual({ ok: true })
    expect(await grace.browser.call('organizations.removeMember', org, grace.id)).toEqual({ ok: false, error: 'last-owner' })

    expect(heard.filter(([event]) => event !== 'member-joined')).toEqual([
      ['organization-created', 'ada@example.com', { organizationId: org }, undefined],
      ['member-roles-changed', 'alan@example.com', { organizationId: org, roles: ['admin'] }, 'grace@example.com'],
      ['member-removed', 'alan@example.com', { organizationId: org }, 'grace@example.com'],
      ['member-roles-changed', 'grace@example.com', { organizationId: org, roles: ['owner'] }, 'ada@example.com'],
      ['member-left', 'ada@example.com', { organizationId: org }, undefined],
    ])
  })

  test('managers rename it and change its slug, and owners alone delete it with its memberships', async () => {
    const { ada, org, person, join, store } = await setup()
    const grace = await person('grace@example.com')

    await join(ada, grace, 'grace@example.com', ['admin'])
    await ada.browser.call('organizations.create', { name: 'Other', slug: 'other' })

    expect(await grace.browser.call('organizations.update', org, { name: 'Acme Inc', slug: 'acme-inc' })).toMatchObject({ ok: true, organization: { name: 'Acme Inc', slug: 'acme-inc' } })
    expect(await grace.browser.call('organizations.update', org, { slug: 'other' })).toEqual({ ok: false, error: 'slug-taken' })
    expect(await grace.browser.call('organizations.update', 'acme-inc', { slug: null })).toMatchObject({ ok: true, organization: { slug: null } })
    expect(await grace.browser.call('organizations.delete', org)).toEqual({ ok: false, error: 'forbidden' })
    expect(await ada.browser.call('organizations.delete', org)).toEqual({ ok: true })
    expect(await store.members!.listByUser(grace.id)).toEqual([])
    expect((await ada.browser.call('organizations.list')).map(found => found.organization.slug)).toEqual(['other'])
  })

  test('deleting a user takes their memberships, and the export lists them', async () => {
    const { ada, org, person, join, store } = await setup()
    const grace = await person('grace@example.com')

    await join(ada, grace, 'grace@example.com')

    expect((await grace.browser.callOk('exportData')).data.organizations).toMatchObject([{ organization: { id: org }, roles: ['member'] }])
    expect(await grace.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
    expect(await store.members!.listByOrganization(org)).toHaveLength(1)
  })

  test('deleting a user takes the invitations to their address', async () => {
    const { ada, org, person, store } = await setup()
    const grace = await person('grace@example.com')

    await ada.browser.call('organizations.invite', org, 'grace@example.com')
    await ada.browser.call('organizations.invite', org, 'alan@example.com')

    expect(await grace.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
    expect(await store.invitations!.listByEmail('grace@example.com')).toEqual([])
    expect(await store.invitations!.listByEmail('alan@example.com')).toHaveLength(1)
  })

  test('a sole owner with other members cannot delete their account, before the proof is spent, until another owner exists', async () => {
    const { ada, org, person, join, store } = await setup()
    const grace = await person('grace@example.com')

    await join(ada, grace, 'grace@example.com')

    expect(await ada.browser.call('deleteAccount', { password: 'wrong password here' })).toEqual({ ok: false, error: 'last-owner' })
    expect(await ada.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: false, error: 'last-owner' })
    expect(await store.users.get(ada.id)).toBeTruthy()
    expect(await store.members!.get(org, ada.id)).toBeTruthy()
    expect(await ada.browser.call('deletionImpact')).toEqual({ deleted: [], blocked: ['Acme'] })

    await ada.browser.callOk('organizations.setMemberRoles', org, grace.id, ['owner'])

    expect(await ada.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
    expect((await store.members!.listByOrganization(org)).map(member => member.userId)).toEqual([grace.id])
    expect(await store.organizations!.get(org)).toBeTruthy()
  })

  test('a sole owner alone in an organization deletes it with their account, its slug freed', async () => {
    const { ada, org, person, store } = await setup()

    expect(await ada.browser.call('deletionImpact')).toEqual({ deleted: ['Acme'], blocked: [] })
    expect(await ada.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
    expect(await store.organizations!.get(org)).toBeUndefined()
    expect(await store.organizations!.findBySlug('acme')).toBeUndefined()
    expect(await store.members!.listByOrganization(org)).toEqual([])

    const grace = await person('grace@example.com')

    expect((await grace.browser.callOk('organizations.create', { name: 'Acme', slug: 'acme' })).membership.organization.slug).toBe('acme')
  })

  test('one of two owners, or a member who is not an owner, deletes their account and the organization stays', async () => {
    const { ada, org, person, join, store } = await setup()
    const grace = await person('grace@example.com')
    const alan = await person('alan@example.com')

    await join(ada, grace, 'grace@example.com', ['owner'])
    await join(ada, alan, 'alan@example.com')

    expect(await alan.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
    expect(await ada.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
    expect((await store.members!.listByOrganization(org)).map(member => member.userId)).toEqual([grace.id])
    expect(await grace.browser.call('deletionImpact')).toEqual({ deleted: ['Acme'], blocked: [] })
  })

  test('a sole owner of several organizations is refused for the one with members, and loses none when refused', async () => {
    const { ada, org, person, join, store } = await setup()
    const grace = await person('grace@example.com')
    const { membership } = await ada.browser.callOk('organizations.create', { name: 'Solo', slug: 'solo' })

    await join(ada, grace, 'grace@example.com')

    expect(await ada.browser.call('deletionImpact')).toEqual({ deleted: ['Solo'], blocked: ['Acme'] })
    expect(await ada.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: false, error: 'last-owner' })
    expect(await store.organizations!.get(membership.organization.id)).toBeTruthy()

    await ada.browser.callOk('organizations.setMemberRoles', org, grace.id, ['owner'])

    expect(await ada.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
    expect(await store.organizations!.get(membership.organization.id)).toBeUndefined()
    expect(await store.organizations!.get(org)).toBeTruthy()
  })

  test('two owners deleting their accounts one after the other keep the organization an owner', async () => {
    const { ada, org, person, join, store } = await setup()
    const grace = await person('grace@example.com')
    const alan = await person('alan@example.com')

    await join(ada, grace, 'grace@example.com', ['owner'])
    await join(ada, alan, 'alan@example.com')

    expect(await ada.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
    expect(await grace.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: false, error: 'last-owner' })
    expect((await store.members!.listByOrganization(org)).map(member => member.userId)).toEqual([grace.id, alan.id])
  })

  // Each deletion's onDelete takes 30 ms, so the two deletions overlap.
  test('two owners whose deletions overlap, each having seen the other, still leave the organization an owner', async () => {
    const { ada, org, person, join, store } = await setup({}, { onDelete: async () => Bun.sleep(30) })
    const grace = await person('grace@example.com')
    const alan = await person('alan@example.com')

    await join(ada, grace, 'grace@example.com', ['owner'])
    await join(ada, alan, 'alan@example.com')

    const answers = await Promise.all([ada.browser.call('deleteAccount', { password: PASSWORD }), grace.browser.call('deleteAccount', { password: PASSWORD })])
    const left = await store.members!.listByOrganization(org)

    expect(answers).toEqual([{ ok: true }, { ok: true }])
    expect(left.map(member => member.userId)).toEqual([alan.id])
    expect(left[0]!.roles).toContain('owner')
  })

  // As above, a 30 ms onDelete keeps the two deletions overlapping.
  test('two owners alone deleting at once leave no organization behind', async () => {
    const { ada, org, person, join, store } = await setup({}, { onDelete: async () => Bun.sleep(30) })
    const grace = await person('grace@example.com')

    await join(ada, grace, 'grace@example.com', ['owner'])
    await Promise.all([ada.browser.call('deleteAccount', { password: PASSWORD }), grace.browser.call('deleteAccount', { password: PASSWORD })])

    expect(await store.members!.listByOrganization(org)).toEqual([])
    expect(await store.organizations!.get(org)).toBeUndefined()
  })

  test('a gate and a guard let through members holding the role in the organization the route names, and a guard without params refuses', async () => {
    const { ada, org, person, join, site, browserOn } = await setup()
    const grace = await person('grace@example.com')
    const alan = await person('alan@example.com')

    await join(ada, grace, 'grace@example.com', ['admin'])

    const status = async (who: { browser: TestBrowser }, path: string) => (await who.browser.fetch(path)).status

    expect(await status(grace, '/orgs/acme/settings')).toBe(200)
    expect(await status(grace, `/orgs/${org}`)).toBe(200)
    expect(await status(alan, '/orgs/acme')).toBe(403)
    expect(await status({ browser: browserOn(site) }, '/orgs/acme')).toBe(401)
    expect(await status(grace, '/orgs/missing/settings')).toBe(403)
    expect(await grace.browser.json('/guarded/acme?params=1')).toBe('ok')
    expect(await alan.browser.json('/guarded/acme?params=1')).toBe('denied 403')
    expect(await grace.browser.json('/guarded/acme')).toBe('denied 403')
  })

  test('a bearer token cannot delete the organization, change roles or remove members, a session can', async () => {
    const { ada, org, person, join, browserOn, site } = await setup()
    const grace = await person('grace@example.com')

    await join(ada, grace, 'grace@example.com')

    const { token } = await ada.browser.callOk('tokens.create', { password: PASSWORD }, 'Script')
    const device = browserOn(site)
    const bearer = async (method: string, ...args: unknown[]) => device.json(`/call/${method}`, { method: 'POST', headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) })

    expect(await bearer('listMembers', org)).toMatchObject({ ok: true })
    expect(await bearer('setMemberRoles', org, grace.id, ['admin'])).toEqual({ ok: false, error: 'signed-out' })
    expect(await bearer('deleteMember', org, grace.id)).toEqual({ ok: false, error: 'signed-out' })
    expect(await bearer('deleteOrganization', org)).toEqual({ ok: false, error: 'signed-out' })
    expect(await ada.browser.call('organizations.members', org)).toMatchObject({ ok: true, members: [{}, { roles: ['member'] }] })
    expect(await ada.browser.call('organizations.setMemberRoles', org, grace.id, ['admin'])).toEqual({ ok: true })
    expect(await ada.browser.call('organizations.delete', org)).toEqual({ ok: true })
  })

  test('a bearer token cannot create, update, invite, revoke, list invitations, accept or decline, a session can', async () => {
    const { ada, org, person, browserOn, site, mails } = await setup()
    const grace = await person('grace@example.com')
    const { invitation } = await ada.browser.callOk('organizations.invite', org, 'grace@example.com')
    const { invitation: spare } = await ada.browser.callOk('organizations.invite', org, 'alan@example.com')
    const adaToken = (await ada.browser.callOk('tokens.create', { password: PASSWORD }, 'Script')).token
    const graceToken = (await grace.browser.callOk('tokens.create', { password: PASSWORD }, 'Script')).token
    const bearer = async (token: string, method: string, ...args: unknown[]) => browserOn(site).json(`/call/${method}`, { method: 'POST', headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) })

    mails.length = 0

    expect(await bearer(graceToken, 'acceptInvitation', invitation.id)).toEqual({ ok: false, error: 'signed-out' })
    expect(await bearer(graceToken, 'rejectInvitation', invitation.id)).toEqual({ ok: false, error: 'signed-out' })
    expect(await bearer(graceToken, 'createOrganization', { name: 'Mine' })).toEqual({ ok: false, error: 'signed-out' })
    expect(await bearer(adaToken, 'updateOrganization', org, { name: 'Renamed' })).toEqual({ ok: false, error: 'signed-out' })
    expect(await bearer(adaToken, 'invite', org, 'bob@example.com')).toEqual({ ok: false, error: 'signed-out' })
    expect(await bearer(adaToken, 'listInvitations', org)).toEqual({ ok: false, error: 'signed-out' })
    expect(await bearer(adaToken, 'revokeInvitation', org, spare.id)).toEqual({ ok: false, error: 'signed-out' })
    expect(mails).toEqual([])
    expect(await grace.browser.call('organizations.list')).toEqual([])
    expect(await bearer(graceToken, 'listMyInvitations')).toMatchObject([{ id: invitation.id }])
    expect(await ada.browser.call('organizations.get', org)).toMatchObject({ organization: { name: 'Acme' } })
    expect(await ada.browser.call('organizations.invitations', org)).toMatchObject({ ok: true, invitations: [{}, {}] })
    expect(await grace.browser.call('organizations.acceptInvitation', invitation.id)).toMatchObject({ ok: true })
    expect(await ada.browser.call('organizations.revokeInvitation', org, spare.id)).toEqual({ ok: true })
  })

  test('inviting needs the invitation page', async () => {
    const { ada, org } = await setup({ invitationPage: undefined })

    expect(await ada.browser.call('organizations.invite', org, 'grace@example.com')).toEqual({ ok: false, error: 'unavailable' })
  })
})
