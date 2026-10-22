import { join } from 'node:path'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { testSite } from 'kay/test'
import { store } from '../src/auth'

// The prebuilt admin pages on the fixture, which names the `admin` role to manage users and declares `editor` beside it.
const ROOT = join(import.meta.dir, '..')
const PAGES = join(ROOT, '..', '..', 'src', 'pages', 'routes')
const PASSWORD = 'correct horse battery'

const browser = () => testSite({ root: ROOT })

await browser()
const { register } = await import(join(PAGES, 'register.kay'))
const { ban, grant, impersonate, remove, revoke, signInAgain, unban } = await import(join(PAGES, 'admin', 'users', '[id].kay'))

type Visitor = Awaited<ReturnType<typeof browser>>
type Page = Awaited<ReturnType<Visitor['visit']>>

const text = (page: Page, selector: string) => page.find(selector)[0]?.text

afterEach(() => {
  setSystemTime()
})

async function member(email: string, roles: string[] = []) {
  const visitor = await browser()

  await visitor.submit(register, { email, password: PASSWORD, redirect: '/auth/account' }, { from: await visitor.visit('/auth/register?redirect=%2Fauth%2Faccount') })

  const { id } = (await store.users.findByEmail(email))!

  if (roles.length > 0)
    await store.users.update(id, { roles })

  return { visitor, id }
}

describe('the admin pages', () => {
  test('a visitor is sent to sign in, a member is refused, and an admin sees the users', async () => {
    const visitor = await browser()

    expect(await visitor.visit('/auth/admin')).toMatchObject({ url: '/auth/sign-in?redirect=%2Fauth%2Fadmin', status: 200 })

    const ada = await member('plain@example.com')

    for (const path of ['/auth/admin', '/auth/admin/audit', `/auth/admin/users/${ada.id}`, '/fr/auth/admin'])
      expect((await ada.visitor.visit(path)).status).toBe(403)

    const root = await member('root-list@example.com', ['admin'])
    const page = await root.visitor.visit('/auth/admin')

    expect(page.status).toBe(200)
    expect(text(page, 'title')).toBe('Users - Administration')
    expect(page.find('[data-user] a').map(link => link.text)).toContain('plain@example.com')
    expect(text(await root.visitor.visit('/fr/auth/admin'), 'title')).toBe('Utilisateurs - Administration')
  })

  test('the search matches part of an email, and a hostile query or page number is read as plain text or the first page', async () => {
    const root = await member('root-search@example.com', ['admin'])

    await member('findme-one@example.com')
    await member('findme-two@example.com')

    const names = async (path: string) => (await root.visitor.visit(path)).find('[data-user] a').map(link => link.text)

    expect(await names('/auth/admin?q=FINDME')).toEqual(['findme-two@example.com', 'findme-one@example.com'])
    expect(await names('/auth/admin?q=%25')).toEqual([])
    expect(await names(`/auth/admin?q=${encodeURIComponent('<script>alert(1)</script>')}`)).toEqual([])
    expect(await names(`/auth/admin?q=${'x'.repeat(5000)}`)).toEqual([])

    for (const page of ['abc', '-3', '0', '1.5', '99999999999999999999', '2'])
      expect((await root.visitor.visit(`/auth/admin?q=findme&page=${page}`)).status).toBe(200)

    const script = await root.visitor.visit(`/auth/admin?q=${encodeURIComponent('"><script>alert(1)</script>')}`)

    expect(script.find('script').filter(found => found.text.includes('alert(1)'))).toHaveLength(0)
  })

  test('a user\'s page gives and takes roles, and an unknown role, or one posted for another user, changes nothing', async () => {
    const root = await member('root-roles@example.com', ['admin'])
    const ada = await member('roles-ada@example.com')
    const from = `/auth/admin/users/${ada.id}`

    expect(await root.visitor.call(grant, { role: 'editor' }, { from })).toBe('done')
    expect((await store.users.get(ada.id))!.roles).toEqual(['editor'])
    expect((await root.visitor.refusal(grant, { role: 'nobody' }, { from })).data).toEqual({ error: 'unknown-role' })

    const page = await root.visitor.visit(from)

    expect(page.find('[data-role]').map(row => row.attributes['data-role'])).toEqual(['editor'])
    expect(await root.visitor.call(revoke, { role: 'editor' }, { from })).toBe('done')
    expect((await store.users.get(ada.id))!.roles).toEqual([])
    expect((await root.visitor.refusal(grant, { role: 'editor' }, { from: '/auth/admin/users/missing' })).data).toEqual({ error: 'not-found' })
  })

  test('a member, or an admin who signed in long ago, changes no one', async () => {
    const root = await member('root-stale@example.com', ['admin'])
    const ada = await member('stale-ada@example.com')
    const grace = await member('stale-grace@example.com')
    const from = `/auth/admin/users/${ada.id}`

    expect((await grace.visitor.refusal(grant, { role: 'editor' }, { from })).data).toEqual({ error: 'forbidden' })
    expect((await grace.visitor.refusal(remove, { confirm: true }, { from })).data).toEqual({ error: 'forbidden' })
    expect((await store.users.get(ada.id))!.roles).toEqual([])

    setSystemTime(new Date(Date.now() + 11 * 60_000))

    const stale = await root.visitor.refusal(ban, {}, { from })

    expect(stale.data).toEqual({ error: 'stale' })
    expect(await root.visitor.submit(signInAgain, {}, { from })).toMatchObject({ url: `/auth/sign-in?redirect=${encodeURIComponent(from)}` })
  })

  test('banning needs a future day, signs the user out, and lifting it lets them in; an admin is not banned', async () => {
    const root = await member('root-ban@example.com', ['admin'])
    const ada = await member('ban-ada@example.com')
    const other = await member('ban-other@example.com', ['admin'])
    const from = `/auth/admin/users/${ada.id}`

    for (const until of ['2000-01-01', 'tomorrow', '2999-13-45'])
      expect((await root.visitor.refusal(ban, { until }, { from })).data).toEqual({ error: 'until' })

    expect((await root.visitor.refusal(ban, {}, { from: `/auth/admin/users/${other.id}` })).data).toEqual({ error: 'admin' })
    expect((await root.visitor.refusal(ban, {}, { from: `/auth/admin/users/${root.id}` })).data).toEqual({ error: 'self' })
    expect(await root.visitor.call(ban, { reason: 'spam <b>', until: '2999-01-01' }, { from })).toBe('done')

    const page = await root.visitor.visit(from)

    expect(page.find('p').map(p => p.text)).toContain('Suspended until Jan 1, 2999.')
    expect(page.find('b')).toHaveLength(0)
    expect((await store.users.get(ada.id))!.banReason).toBe('spam <b>')
    expect((await ada.visitor.visit('/auth/account')).url).toStartWith('/auth/sign-in')
    expect(await root.visitor.call(unban, {}, { from })).toBe('done')
    expect((await store.users.get(ada.id))!.bannedAt).toBeNull()
  })

  test('deleting needs the box ticked and removes the user; an admin acting as someone sees the banner and goes back', async () => {
    const root = await member('root-act@example.com', ['admin'])
    const ada = await member('act-ada@example.com')
    const from = `/auth/admin/users/${ada.id}`
    const acted = await root.visitor.submit(impersonate, {}, { from })

    expect(acted.url).toBe('/')
    expect(text(await root.visitor.visit('/auth/account'), '[data-impersonating] span')).toBe('You are acting as act-ada@example.com.')
    expect((await root.visitor.visit('/auth/admin')).status).toBe(403)

    const back = await root.visitor.fetch('/auth/stop-impersonating', { method: 'POST', body: new URLSearchParams({ redirect: '/auth/admin' }) })

    expect([back.status, back.headers.get('location')]).toEqual([303, '/auth/admin'])
    expect((await root.visitor.visit('/auth/admin')).status).toBe(200)
    expect((await root.visitor.refusal(remove, {}, { from })).data).toEqual({ error: 'form' })
    expect(await store.users.get(ada.id)).toBeDefined()
    expect(await root.visitor.submit(remove, { confirm: 'on' }, { from })).toMatchObject({ url: '/auth/admin' })
    expect(await store.users.get(ada.id)).toBeUndefined()
  })

  test('the audit log page opens for an admin only, and a cursor that is no date shows an empty page', async () => {
    const root = await member('root-audit@example.com', ['admin'])
    const ada = await member('audit-ada@example.com')

    expect((await ada.visitor.visit('/auth/admin/audit')).status).toBe(403)
    expect((await root.visitor.visit('/auth/admin/audit')).status).toBe(200)

    for (const before of ['not json', '{"at":"nope","id":"x"}', JSON.stringify('x'.repeat(5000))])
      expect((await root.visitor.visit(`/auth/admin/audit?before=${encodeURIComponent(before)}`)).status).toBe(200)
  })
})

test('with the audit log on, a user\'s page and the audit page word what happened, in the visitor\'s language', async () => {
  const root = await member('root-words@example.com', ['admin'])
  const ada = await member('words-ada@example.com')

  await root.visitor.call(grant, { role: 'editor' }, { from: `/auth/admin/users/${ada.id}` })

  const page = await root.visitor.visit(`/auth/admin/users/${ada.id}`)

  expect(page.find('.kui-card-row span').map(span => span.text)).toContain('Role editor granted')
  expect((await root.visitor.visit('/auth/admin/audit')).find('.kui-card-row span').map(span => span.text)).toContain('Role editor granted')
  expect((await root.visitor.visit(`/fr/auth/admin/users/${ada.id}`)).status).toBe(200)
})

test('the audit page pages through entries with a link carrying only the last one\'s time and id, whatever a user agent holds', async () => {
  const root = await member('root-paging@example.com', ['admin'])
  const base = Date.UTC(2001, 0, 1)

  for (let index = 0; index < 60; index++)
    await store.audit!.add({ id: `paging-${String(index).padStart(3, '0')}`, userId: 'someone', event: 'signed-out', detail: null, ip: '1.2.3.0', userAgent: 'x'.repeat(3000), actorId: null, at: new Date(base + index) })

  const first = await root.visitor.visit('/auth/admin/audit')
  const older = first.find('a[rel="next"]')[0]!.attributes.href!

  expect(decodeURIComponent(older)).not.toContain('xxxx')
  expect(first.find('.kui-card-row').length).toBe(50)

  const second = await root.visitor.visit(older)

  expect(second.status).toBe(200)
  expect(second.find('.kui-card-row').length).toBeGreaterThan(0)
  expect(second.find('.kui-card-row').length).toBeLessThanOrEqual(50)
})
