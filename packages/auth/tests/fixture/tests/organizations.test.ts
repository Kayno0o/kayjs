import { join } from 'node:path'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { testSite } from 'kay/test'
import { mails, store } from '../src/auth'

// The prebuilt organization pages and the invitation page on the fixture, whose roles are owner, admin and member, admin managing.
const ROOT = join(import.meta.dir, '..')
const PAGES = join(ROOT, '..', '..', 'src', 'pages', 'routes')
const PASSWORD = 'correct horse battery'

const browser = () => testSite({ root: ROOT })

await browser()
const { register } = await import(join(PAGES, 'register.kay'))
const { password } = await import(join(PAGES, 'sign-in.kay'))
const { create, accept: acceptMine, reject: rejectMine } = await import(join(PAGES, 'account', 'organizations', 'index.kay'))
const { invite, leave, removeMember, remove, rename, revoke, setRoles } = await import(join(PAGES, 'account', 'organizations', '[org].kay'))
const { accept, reject, switchAccount } = await import(join(PAGES, 'invitation.kay'))

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof browser>>['visit']>>

const text = (page: Page, selector: string) => page.find(selector)[0]?.text
const LIST = '/auth/account/organizations'

afterEach(() => {
  setSystemTime()
})

async function person(email: string) {
  const visitor = await browser()

  await visitor.submit(register, { email, password: PASSWORD, redirect: '/auth/account' }, { from: await visitor.visit('/auth/register?redirect=%2Fauth%2Faccount') })

  const { id } = (await store.users.findByEmail(email))!

  await store.users.update(id, { emailVerifiedAt: new Date() })

  return { visitor, id, email }
}

async function founded(name: string, slug: string, email = `${slug}-owner@example.com`) {
  const owner = await person(email)
  const made = await owner.visitor.submit(create, { name, slug }, { from: await owner.visitor.visit(LIST) })

  expect(made.url).toBe(`${LIST}/${slug}`)

  return { owner, from: `${LIST}/${slug}` }
}

async function member(slug: string, owner: Awaited<ReturnType<typeof person>>, email: string, roles: string[]) {
  const who = await person(email)
  const mailed = await owner.visitor.call(invite, { email, roles }, { from: `${LIST}/${slug}` })

  expect(mailed).toBe(email)

  const link = new URL(mails.findLast(mail => mail.kind === 'invitation')!.url!)

  expect((await who.visitor.submit(accept, { id: link.searchParams.get('invitation')! }, { from: await who.visitor.visit(link.pathname + link.search) })).url).toBe(`${LIST}/${slug}`)

  return who
}

const linkOf = () => new URL(mails.findLast(mail => mail.kind === 'invitation')!.url!)

describe('the organization pages', () => {
  test('a visitor is sent to sign in, a member of nothing sees the empty list, and a stranger gets a 404 for an organization they are not in', async () => {
    const visitor = await browser()

    expect(await visitor.visit(LIST)).toMatchObject({ url: `/auth/sign-in?redirect=${encodeURIComponent(LIST)}` })

    const { from } = await founded('Acme', 'acme-gate')
    const stranger = await person('gate-stranger@example.com')
    const list = await stranger.visitor.visit(LIST)

    expect([list.status, text(list, 'title'), list.find('.kui-empty-state-title').map(title => title.text)]).toEqual([200, 'Organizations - Your account', ['You belong to no organization yet.']])
    expect(list.find('.kui-tab-nav a').map(link => link.text)).toContain('Organizations')
    expect((await stranger.visitor.visit(from)).status).toBe(404)
    expect(text(await stranger.visitor.visit('/fr/auth/account/organizations'), 'title')).toBe('Organisations - Votre compte')
  })

  test('creating an organization lands on its page, the creator an owner, and a bad name or a taken address is told', async () => {
    const { owner, from } = await founded('Acme Gate', 'acme-new')
    const page = await owner.visitor.visit(from)

    expect(page.status).toBe(200)
    expect(text(page, 'title')).toBe('Acme Gate - Organizations')
    expect(page.find('[data-member]').map(row => row.attributes['data-member'])).toEqual([owner.id])
    expect(page.find('input[name="confirm"]')).toHaveLength(1)

    const other = await person('new-other@example.com')
    const lists = await other.visitor.visit(LIST)

    expect((await other.visitor.refusal(create, { name: 'Taken', slug: 'acme-new' }, { from: lists.url })).data).toEqual({ error: 'slug-taken' })
    expect((await other.visitor.refusal(create, { name: '  ', slug: '' }, { from: lists.url })).data).toEqual({ error: 'invalid-name' })
    expect((await other.visitor.refusal(create, { name: 'Fine', slug: 'Not A Slug' }, { from: lists.url })).data).toEqual({ error: 'invalid-slug' })
  })

  test('a plain member sees no management and every action refuses them, an admin cannot touch an owner, and a stranger\'s post changes nothing', async () => {
    const { owner, from } = await founded('Roles Inc', 'roles-inc')
    const admin = await member('roles-inc', owner, 'roles-admin@example.com', ['admin'])
    const plain = await member('roles-inc', owner, 'roles-plain@example.com', ['member'])
    const stranger = await person('roles-stranger@example.com')
    const seen = await plain.visitor.visit(from)

    expect([seen.find('input[name="email"]').length, seen.find('[data-member] form').length, seen.find('input[name="roles"]').length, seen.find('input[name="confirm"]').length]).toEqual([0, 0, 0, 0])

    const forbidden = { error: 'forbidden' }

    expect((await plain.visitor.refusal(setRoles, { userId: admin.id, roles: ['member'] }, { from })).data).toEqual(forbidden)
    expect((await plain.visitor.refusal(removeMember, { userId: admin.id }, { from })).data).toEqual(forbidden)
    expect((await plain.visitor.refusal(invite, { email: 'x@example.com' }, { from })).data).toEqual(forbidden)
    expect((await plain.visitor.refusal(rename, { name: 'Mine' }, { from })).data).toEqual(forbidden)
    expect((await plain.visitor.refusal(remove, { confirm: true }, { from })).data).toEqual(forbidden)
    expect((await plain.visitor.refusal(revoke, { id: 'whatever' }, { from })).data).toEqual({ error: 'forbidden' })

    // An admin manages the members below them and nothing above.
    expect((await admin.visitor.refusal(setRoles, { userId: owner.id, roles: [] }, { from })).data).toEqual(forbidden)
    expect((await admin.visitor.refusal(removeMember, { userId: owner.id }, { from })).data).toEqual(forbidden)
    expect((await admin.visitor.refusal(setRoles, { userId: plain.id, roles: ['owner'] }, { from })).data).toEqual(forbidden)
    expect((await admin.visitor.refusal(remove, { confirm: true }, { from })).data).toEqual(forbidden)
    expect(await admin.visitor.call(setRoles, { userId: plain.id, roles: ['admin'] }, { from })).toBe('done')

    const adminView = await admin.visitor.visit(from)

    expect(adminView.find(`[data-member="${owner.id}"] form`)).toHaveLength(0)
    expect(adminView.find(`[data-member="${plain.id}"] input[name="roles"]`).map(box => box.attributes.value)).toEqual(['admin', 'member'])
    expect(adminView.find('input[name="confirm"]')).toHaveLength(0)

    // A post from a page of an organization they are in never reaches another one.
    for (const action of [setRoles, removeMember])
      expect((await stranger.visitor.refusal(action, { userId: plain.id, roles: [] }, { from })).data).toEqual({ error: 'not-found' })

    expect((await stranger.visitor.refusal(remove, { confirm: true }, { from })).data).toEqual({ error: 'not-found' })
    expect((await store.members!.listByOrganization((await store.organizations!.findBySlug('roles-inc'))!.id)).map(row => row.userId)).toHaveLength(3)
  })

  test('the last owner cannot leave, lose the role or be removed, and an owner who is not the last can', async () => {
    const { owner, from } = await founded('Last Owner', 'last-owner')
    const second = await member('last-owner', owner, 'last-second@example.com', ['owner'])

    expect(await owner.visitor.call(setRoles, { userId: owner.id, roles: ['admin'] }, { from })).toBe('done')

    // `second` is the last owner now.
    for (const [action, input] of [[setRoles, { userId: second.id, roles: ['admin'] }], [removeMember, { userId: second.id }], [leave, {}]] as const)
      expect((await second.visitor.refusal(action, input as never, { from })).data).toEqual({ error: 'last-owner' })

    expect((await store.members!.get((await store.organizations!.findBySlug('last-owner'))!.id, second.id))!.roles).toEqual(['owner'])
  })

  test('roles, removal, rename, leaving and deleting work from the page, and a rename moves the page', async () => {
    const { owner, from } = await founded('Whole Cycle', 'whole-cycle')
    const ada = await member('whole-cycle', owner, 'cycle-ada@example.com', ['member'])

    expect(await owner.visitor.call(setRoles, { userId: ada.id, roles: ['admin', 'member'] }, { from })).toBe('done')
    expect((await owner.visitor.visit(from)).find(`[data-member="${ada.id}"] .kui-badge`).map(badge => badge.text)).toEqual(['admin', 'member'])
    expect((await owner.visitor.refusal(setRoles, { userId: ada.id, roles: ['nobody'] }, { from })).data).toEqual({ error: 'unknown-role' })
    expect((await owner.visitor.submit(rename, { name: 'Renamed', slug: 'renamed-cycle' }, { from })).url).toBe(`${LIST}/renamed-cycle`)
    expect((await owner.visitor.visit(from)).status).toBe(404)
    expect(await owner.visitor.call(removeMember, { userId: ada.id }, { from: `${LIST}/renamed-cycle` })).toBe('done')
    expect((await ada.visitor.visit(LIST)).find('[data-organization]')).toHaveLength(0)
    expect((await owner.visitor.refusal(remove, {}, { from: `${LIST}/renamed-cycle` })).data).toEqual({ error: 'form' })
    expect((await owner.visitor.submit(remove, { confirm: 'on' }, { from: `${LIST}/renamed-cycle` })).url).toBe(LIST)
    expect(await store.organizations!.findBySlug('renamed-cycle')).toBeUndefined()
  })

  test('the page and its words follow the locale', async () => {
    const { owner } = await founded('Mon Équipe', 'fr-team')
    const page = await owner.visitor.visit('/fr/auth/account/organizations/fr-team')

    expect(page.status).toBe(200)
    expect(page.find('h2, h3').map(heading => heading.text)).toEqual(expect.arrayContaining(['Membres', 'Invitations', 'Quitter l’organisation', 'Supprimer l’organisation']))
    expect(page.find('input[name="roles"]').length).toBeGreaterThan(0)
  })
})

describe('inviting', () => {
  test('a manager invites, the link opens the prebuilt page, the open invitation can be revoked, and one the manager cannot give is refused', async () => {
    const { owner, from } = await founded('Invite Co', 'invite-co')
    const sent = await owner.visitor.submit(invite, { email: 'Guest-One@Example.com', roles: ['member'] }, { from: await owner.visitor.visit(from) })

    expect(sent.find('p.kauth-success').map(p => p.text)).toEqual(['Invitation sent to guest-one@example.com.'])
    expect(linkOf().pathname).toBe('/auth/invitation')

    const page = await owner.visitor.visit(from)

    expect(page.find('[data-invitation] strong').map(row => row.text)).toEqual(['guest-one@example.com'])

    const id = page.find('[data-invitation]')[0]!.attributes['data-invitation']!

    expect(await owner.visitor.call(revoke, { id }, { from })).toBe('done')
    expect((await owner.visitor.visit(from)).find('[data-invitation]')).toHaveLength(0)
    expect((await owner.visitor.visit(`/auth/invitation?invitation=${id}`)).find('p.kauth-error').map(p => p.text)).toEqual(['This invitation is invalid, expired or already used.'])
    expect((await owner.visitor.refusal(invite, { email: 'no-at-sign' }, { from })).data).toEqual({ error: 'invalid-email' })
    expect((await owner.visitor.refusal(invite, { email: 'role@example.com', roles: ['nobody'] }, { from })).data).toEqual({ error: 'unknown-role' })
  })

  test('signed out, the page offers sign-in and registration that come back to it, and the invitee then joins', async () => {
    const { owner, from } = await founded('Back Co', 'back-co')

    await owner.visitor.call(invite, { email: 'back-invitee@example.com', roles: ['member'] }, { from })

    const link = linkOf()
    const visitor = await browser()
    const page = await visitor.visit(link.pathname + link.search)
    const here = encodeURIComponent(`/auth/invitation${link.search}`)

    expect(page.status).toBe(200)
    expect(page.find('p').map(p => p.text)).toContain('You are invited to join Back Co.')
    expect(page.find('a').map(a => a.attributes.href)).toEqual(expect.arrayContaining([`/auth/sign-in?redirect=${here}`, `/auth/register?redirect=${here}`]))
    expect(page.find('form')).toHaveLength(0)
    expect((await visitor.refusal(accept, { id: link.searchParams.get('invitation')! }, { from: page.url })).data).toEqual({ error: 'signed-out' })

    // Registering with the invited address comes back to the invitation; the address is verified, then the invitation is accepted.
    const back = await visitor.submit(register, { email: 'back-invitee@example.com', password: PASSWORD, redirect: `/auth/invitation${link.search}` }, { from: await visitor.visit(`/auth/register?redirect=${here}`) })

    expect(back.url).toBe(`/auth/invitation${link.search}`)

    const { id } = (await store.users.findByEmail('back-invitee@example.com'))!

    expect((await visitor.refusal(accept, { id: link.searchParams.get('invitation')! }, { from: back.url })).data).toEqual({ error: 'unverified' })
    await store.users.update(id, { emailVerifiedAt: new Date() })
    expect((await visitor.submit(accept, { id: link.searchParams.get('invitation')! }, { from: back })).url).toBe(from)
    expect((await store.members!.get((await store.organizations!.findBySlug('back-co'))!.id, id))!.roles).toEqual(['member'])
  })

  test('signed in as the invited address the page joins, and the invitation is spent', async () => {
    const { owner, from } = await founded('Join Co', 'join-co')
    const ada = await person('join-ada@example.com')

    await owner.visitor.call(invite, { email: 'join-ada@example.com' }, { from })

    const link = linkOf()
    const page = await ada.visitor.visit(link.pathname + link.search)

    expect(page.find('form button').map(button => button.text)).toEqual(['Join', 'Decline'])
    expect((await ada.visitor.submit(accept, { id: link.searchParams.get('invitation')! }, { from: page })).url).toBe(from)
    expect((await ada.visitor.visit(link.pathname + link.search)).find('p.kauth-error').map(p => p.text)).toEqual(['This invitation is invalid, expired or already used.'])
    expect((await ada.visitor.refusal(accept, { id: link.searchParams.get('invitation')! }, { from: page.url })).data).toEqual({ error: 'not-found' })
    expect((await ada.visitor.visit(from)).find('[data-member]')).toHaveLength(2)
  })

  test('an expired invitation, another address, a tampered id and one declined are all refused', async () => {
    const { owner, from } = await founded('Refuse Co', 'refuse-co')
    const ada = await person('refuse-ada@example.com')
    const eve = await person('refuse-eve@example.com')

    await owner.visitor.call(invite, { email: 'refuse-ada@example.com' }, { from })

    const link = linkOf()
    const id = link.searchParams.get('invitation')!
    const path = link.pathname + link.search
    const wrong = await eve.visitor.visit(path)

    expect(wrong.find('p.kauth-error').map(p => p.text)).toEqual(['This invitation is for another address: sign in with the address it was sent to.'])
    expect(wrong.find('button').map(button => button.text)).toEqual(['Sign in with another account'])
    expect((await eve.visitor.refusal(accept, { id }, { from: wrong.url })).data).toEqual({ error: 'wrong-account' })
    expect((await eve.visitor.refusal(reject, { id }, { from: wrong.url })).data).toEqual({ error: 'not-found' })

    for (const tampered of [`${id}x`, id.toUpperCase(), '../../etc', `${id}%00`, 'x'.repeat(5000), ''])
      expect((await ada.visitor.visit(`/auth/invitation?invitation=${encodeURIComponent(tampered)}`)).find('p.kauth-error').map(p => p.text)).toEqual(['This invitation is invalid, expired or already used.'])

    expect((await ada.visitor.visit('/auth/invitation')).status).toBe(200)
    expect((await ada.visitor.refusal(accept, { id: 'tampered' }, { from: path })).data).toEqual({ error: 'not-found' })

    // A week and a day on the invitation is gone; the invitee signs in again as their session ended too.
    setSystemTime(new Date(Date.now() + 8 * 24 * 3600_000))

    const later = await browser()

    await later.submit(password, { identifier: 'refuse-ada@example.com', password: PASSWORD }, { from: await later.visit('/auth/sign-in') })
    expect((await later.visit(path)).find('p.kauth-error')).toHaveLength(1)
    expect((await later.refusal(accept, { id }, { from: wrong.url })).data).toEqual({ error: 'not-found' })
    setSystemTime()

    await owner.visitor.call(invite, { email: 'refuse-ada@example.com' }, { from })

    const again = linkOf()

    expect((await ada.visitor.visit('/auth/account/organizations')).find('[data-invitation]')).toHaveLength(1)
    expect((await ada.visitor.submit(reject, { id: again.searchParams.get('invitation')! }, { from: await ada.visitor.visit(again.pathname + again.search) })).url).toBe(LIST)
    expect((await ada.visitor.visit(again.pathname + again.search)).find('p.kauth-error')).toHaveLength(1)
  })

  test('the wrong account signs out and signs in again, coming back to the link', async () => {
    const { owner, from } = await founded('Switch Co', 'switch-co')
    const eve = await person('switch-eve@example.com')

    await owner.visitor.call(invite, { email: 'switch-ada@example.com' }, { from })

    const link = linkOf()
    const id = link.searchParams.get('invitation')!
    const went = await eve.visitor.submit(switchAccount, { id }, { from: await eve.visitor.visit(link.pathname + link.search) })

    expect(went.url).toBe(`/auth/sign-in?redirect=${encodeURIComponent(`/auth/invitation?invitation=${id}`)}`)

    const ada = await person('switch-ada@example.com')
    const back = await ada.visitor.submit(password, { identifier: 'switch-ada@example.com', password: PASSWORD, redirect: `/auth/invitation?invitation=${id}` }, { from: await ada.visitor.visit(`/auth/sign-in?redirect=${encodeURIComponent(`/auth/invitation?invitation=${id}`)}`) })

    expect(back.url).toBe(`/auth/invitation?invitation=${id}`)
  })

  test('the invitation page speaks French and the list page offers the invitations open to the signed-in address', async () => {
    const { owner, from } = await founded('Fr Co', 'fr-co')
    const ada = await person('fr-ada@example.com')

    await owner.visitor.call(invite, { email: 'fr-ada@example.com' }, { from })

    const link = linkOf()
    const page = await ada.visitor.visit(`/fr${link.pathname}${link.search}`)

    expect(page.find('p').map(p => p.text)).toContain('Vous êtes invité à rejoindre Fr Co.')
    expect(page.find('form button').map(button => button.text)).toEqual(['Rejoindre', 'Refuser'])

    const list = await ada.visitor.visit(LIST)
    const row = list.find('[data-invitation]')[0]!

    expect(row.attributes['data-invitation']).toBe(link.searchParams.get('invitation')!)
    expect((await ada.visitor.submit(acceptMine, { id: row.attributes['data-invitation']! }, { from: list })).url).toBe(from)
    expect(rejectMine).toBeDefined()
  })
})
