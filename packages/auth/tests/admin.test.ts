import type { User } from '../src/auth'
import type { AuthEvent, AuthEventInfo, EventContext } from '../src/events'
import type { Mail } from '../src/mail'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const ADMIN_EVENTS = new Set<AuthEvent>(['role-granted', 'role-revoked', 'banned', 'unbanned', 'account-deleted', 'impersonation-started', 'impersonation-ended'])

afterEach(() => {
  setSystemTime()
})

async function setup(options: Parameters<typeof testApp>[0] = {}) {
  const events: { event: AuthEvent, user: User, detail: string | undefined, context: EventContext }[] = []
  const heard: AuthEventInfo[] = []
  const app = testApp({
    admin: 'admin',
    onEvent: (event, user, detail, context) => {
      events.push({ event, user, detail, context })
    },
    onAuthEvent: (info) => {
      heard.push(info)
    },
    ...options,
  })

  app.app.post('/ban', async ({ auth, body }) => {
    const { id, until, reason } = body as { id: string, until?: string, reason?: string }

    return auth.banUser(id, { ...until === undefined ? {} : { until: new Date(until) }, ...reason === undefined ? {} : { reason } })
  })

  const member = async (email: string, roles: string[] = []) => {
    const browser = app.browser()
    const { user } = await browser.callHas('user', 'register', { email, password: PASSWORD })

    await app.store.users.update(user.id, { roles })

    return { browser, id: user.id }
  }
  const admin = await member('root@example.com', ['admin'])
  const ada = await member('ada@example.com')
  // Who did what to whom, among the admin's events.
  const said = () => events.filter(entry => ADMIN_EVENTS.has(entry.event)).map(entry => [entry.event, entry.user.email, entry.detail, entry.context.actor?.email])

  // The same events as `onAuthEvent` hears them: the event, its fields and who acted.
  const told = () => heard.filter(info => ADMIN_EVENTS.has(info.event)).map((info) => {
    const { event, user, context, ...fields } = info

    return [event, user.email, fields, context.actor?.email]
  })

  return { ...app, events, said, told, member, admin, ada }
}

describe('admin', () => {
  test('without the admin option, or to a user it does not name, every admin method answers forbidden', async () => {
    const plain = await setup({ admin: undefined })

    expect(await plain.admin.browser.call('listUsers')).toEqual({ ok: false, error: 'forbidden' })

    const { ada, admin } = await setup()

    expect(await ada.browser.call('listUsers')).toEqual({ ok: false, error: 'forbidden' })
    expect(await ada.browser.call('getUser', admin.id)).toEqual({ ok: false, error: 'forbidden' })
    expect(await ada.browser.call('grantRole', ada.id, 'admin')).toEqual({ ok: false, error: 'forbidden' })
    expect(await ada.browser.call('banUser', admin.id)).toEqual({ ok: false, error: 'forbidden' })
    expect(await ada.browser.call('deleteUser', admin.id)).toEqual({ ok: false, error: 'forbidden' })
    expect(await ada.browser.call('impersonate', admin.id)).toEqual({ ok: false, error: 'forbidden' })
    expect(await ada.browser.call('adminAuditLog')).toEqual({ ok: false, error: 'forbidden' })
  })

  test('an admin\'s bearer token manages no one, whatever it may do elsewhere', async () => {
    const { admin, ada, browser } = await setup()
    const { token } = await admin.browser.callOk('createToken', { password: PASSWORD }, 'CLI')
    const withToken = async (method: string, ...args: unknown[]) => browser().json(`/call/${method}`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    })

    expect(await withToken('listUsers')).toEqual({ ok: false, error: 'forbidden' })
    expect(await withToken('getUser', ada.id)).toEqual({ ok: false, error: 'forbidden' })
    expect(await withToken('grantRole', ada.id, 'admin')).toEqual({ ok: false, error: 'forbidden' })
    expect(await withToken('banUser', ada.id)).toEqual({ ok: false, error: 'forbidden' })
    expect(await withToken('deleteUser', ada.id)).toEqual({ ok: false, error: 'forbidden' })
    expect(await withToken('adminAuditLog')).toEqual({ ok: false, error: 'forbidden' })
  })

  test('an admin changes users only within ten minutes of signing in or re-proving, and reads them any time', async () => {
    const { admin, ada } = await setup()

    setSystemTime(new Date(Date.now() + 11 * 60_000))

    expect(await admin.browser.call('grantRole', ada.id, 'admin')).toEqual({ ok: false, error: 'stale' })
    expect(await admin.browser.call('revokeRole', ada.id, 'admin')).toEqual({ ok: false, error: 'stale' })
    expect(await admin.browser.call('banUser', ada.id)).toEqual({ ok: false, error: 'stale' })
    expect(await admin.browser.call('unbanUser', ada.id)).toEqual({ ok: false, error: 'stale' })
    expect(await admin.browser.call('deleteUser', ada.id)).toEqual({ ok: false, error: 'stale' })
    expect(await admin.browser.call('getUser', ada.id)).toMatchObject({ ok: true })

    expect(await admin.browser.call('reprove', { password: PASSWORD })).toEqual({ ok: true })
    expect(await admin.browser.call('banUser', ada.id)).toMatchObject({ ok: true })
  })

  test('users list newest first, a page at a time, searched', async () => {
    const { admin, member } = await setup()

    // Created a second later, as users sharing a millisecond list in no set order.
    setSystemTime(new Date(Date.now() + 1000))
    await member('bob@example.com')

    const all = await admin.browser.callOk('listUsers')

    expect(all.total).toBe(3)
    expect(all.users.map((user: User) => user.email)).toContain('bob@example.com')
    expect(all.users[0]).toMatchObject({ email: 'bob@example.com', roles: [], ban: null, hasPassword: true })
    expect(await admin.browser.call('listUsers', { search: 'BOB', limit: 1 })).toMatchObject({ ok: true, users: [{ email: 'bob@example.com' }], total: 1 })
    expect((await admin.browser.callOk('listUsers', { offset: 2, limit: 5 })).users).toHaveLength(1)
  })

  test('a role granted or revoked counts on the user\'s next request; only declared roles are given', async () => {
    const { admin, ada, said, told } = await setup()

    expect(await admin.browser.post('/call/grantRole', [ada.id, 'owner'])).toEqual({ ok: false, error: 'unknown-role' })
    expect(await admin.browser.call('grantRole', 'missing', 'editor')).toEqual({ ok: false, error: 'not-found' })
    expect(await admin.browser.call('grantRole', ada.id, 'editor')).toMatchObject({ ok: true, user: { roles: ['editor'] } })
    expect(await ada.browser.json('/me')).toMatchObject({ roles: ['editor'] })

    // Already held: nothing to tell.
    await admin.browser.call('grantRole', ada.id, 'editor')
    await admin.browser.call('revokeRole', ada.id, 'editor')

    expect(await ada.browser.json('/me')).toMatchObject({ roles: [] })
    expect(said()).toEqual([['role-granted', 'ada@example.com', 'editor', 'root@example.com'], ['role-revoked', 'ada@example.com', 'editor', 'root@example.com']])
    expect(told()).toEqual([['role-granted', 'ada@example.com', { role: 'editor' }, 'root@example.com'], ['role-revoked', 'ada@example.com', { role: 'editor' }, 'root@example.com']])
  })

  test('a ban signs the user out everywhere, devices included, and refuses their sign-ins until lifted', async () => {
    const { admin, ada, browser, said, told, store } = await setup()
    const { token } = await ada.browser.callOk('createToken', { password: PASSWORD }, 'Phone')

    expect(await admin.browser.post('/ban', { id: ada.id, reason: ' spam ' })).toMatchObject({ ok: true, user: { ban: { reason: 'spam', until: null } } })
    expect(await ada.browser.json('/me')).toBe('anonymous')
    expect(await browser().json('/me', { headers: { authorization: `Bearer ${token}` } })).toBe('anonymous')
    expect(await browser().post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'banned' })
    expect((await browser().fetch(`/sign-in/${ada.id}`, { method: 'POST' })).status).toBe(500)
    expect((await store.users.get(ada.id))!.banReason).toBe('spam')

    expect(await admin.browser.call('unbanUser', ada.id)).toMatchObject({ ok: true, user: { ban: null } })
    expect(await browser().post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
    expect(said()).toEqual([['banned', 'ada@example.com', 'spam', 'root@example.com'], ['unbanned', 'ada@example.com', undefined, 'root@example.com']])
    expect(told()).toEqual([['banned', 'ada@example.com', { reason: 'spam' }, 'root@example.com'], ['unbanned', 'ada@example.com', {}, 'root@example.com']])
  })

  test('a ban whose reason is blank keeps none', async () => {
    const { admin, ada, store } = await setup()

    expect(await admin.browser.post('/ban', { id: ada.id, reason: '  ' })).toMatchObject({ ok: true, user: { ban: { reason: null } } })
    expect((await store.users.get(ada.id))!.banReason).toBeNull()
  })

  test('a ban until a date lifts itself then', async () => {
    const { admin, ada, browser } = await setup()
    const until = new Date(Date.now() + 60 * 60 * 1000)

    expect(await admin.browser.post('/ban', { id: ada.id, until: new Date(Date.now() - 1000).toISOString() })).toEqual({ ok: false, error: 'until' })
    expect(await admin.browser.post('/ban', { id: ada.id, until: until.toISOString() })).toMatchObject({ ok: true, user: { ban: { until: until.toISOString() } } })
    expect(await browser().post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'banned' })

    setSystemTime(new Date(until.getTime() + 1000))

    expect(await browser().post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ ok: true })
  })

  test('an admin cannot take back their own admin role, which would leave the last one with no way back, though another of theirs goes', async () => {
    const { admin, member, store } = await setup()

    expect(await admin.browser.call('revokeRole', admin.id, 'admin')).toEqual({ ok: false, error: 'self' })
    expect((await store.users.get(admin.id))?.roles).toEqual(['admin'])

    await admin.browser.call('grantRole', admin.id, 'editor')

    expect(await admin.browser.call('revokeRole', admin.id, 'editor')).toMatchObject({ ok: true, user: { roles: ['admin'] } })

    const other = await member('second@example.com', ['admin'])

    expect(await admin.browser.call('revokeRole', other.id, 'admin')).toMatchObject({ ok: true, user: { roles: [] } })
  })

  test('an admin cannot ban themselves or another admin', async () => {
    const { admin, member } = await setup()
    const other = await member('second@example.com', ['admin'])

    expect(await admin.browser.post('/ban', { id: admin.id })).toEqual({ ok: false, error: 'self' })
    expect(await admin.browser.post('/ban', { id: other.id })).toEqual({ ok: false, error: 'admin' })
  })

  test('an admin cannot delete themselves or another admin, and a missing user is not found', async () => {
    const { admin, member, store } = await setup()
    const other = await member('second@example.com', ['admin'])

    expect(await admin.browser.call('deleteUser', admin.id)).toEqual({ ok: false, error: 'self' })
    expect(await admin.browser.call('deleteUser', other.id)).toEqual({ ok: false, error: 'admin' })
    expect(await admin.browser.call('deleteUser', 'nobody')).toEqual({ ok: false, error: 'not-found' })
    expect(await store.users.get(other.id)).toBeTruthy()
  })

  test('deleting a user removes them, tells the app, mails them and logs the admin as the actor', async () => {
    const deleted: User[] = []
    const mails: Mail[] = []
    const { admin, ada, store, said, browser } = await setup({
      audit: true,
      url: 'https://site.test',
      email: { mailer: { send: (mail: Mail) => void mails.push(mail) }, links: { 'verify-email': '/v', 'reset-password': '/r', 'magic-link': '/m', 'change-email': '/c' }, requireVerified: false },
      onDelete: (user: User) => {
        deleted.push(user)
      },
    })

    await store.users.update(ada.id, { emailVerifiedAt: new Date() })
    mails.length = 0

    expect(await admin.browser.call('deleteUser', ada.id)).toEqual({ ok: true })
    expect(await store.users.get(ada.id)).toBeUndefined()
    expect(deleted.map(user => user.email)).toEqual(['ada@example.com'])
    expect(mails.map(mail => [mail.kind, mail.to])).toEqual([['account-deleted', 'ada@example.com']])
    expect(said()).toEqual([['account-deleted', 'ada@example.com', undefined, 'root@example.com']])
    expect(await ada.browser.json('/me')).toBe('anonymous')
    expect(await browser().post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toEqual({ ok: false, error: 'invalid' })

    // The entry stays, under a name that no longer leads to the user.
    const log = await admin.browser.callOk('adminAuditLog', {})
    const entry = log.entries.find((found: { event: string }) => found.event === 'account-deleted')

    expect(entry).toMatchObject({ actorId: admin.id })
    expect(entry!.userId).not.toBe(ada.id)
    expect((await admin.browser.callOk('adminAuditLog', { userId: ada.id })).entries).toEqual([])
  })

  test('a deleted admin is no longer named in what they did to others', async () => {
    const { admin, ada, member, store } = await setup({ audit: true })

    // Another admin, so this one is not the last.
    await member('grace@example.com', ['admin'])

    await admin.browser.call('grantRole', ada.id, 'editor')

    expect(await admin.browser.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })

    const granted = (await store.audit!.list({ userId: ada.id, limit: 10 })).find(entry => entry.event === 'role-granted')!

    expect(granted).toMatchObject({ userId: ada.id, detail: 'editor', ip: '', userAgent: '' })
    expect(granted.actorId).not.toBe(admin.id)
    expect(granted.actorId).not.toBeNull()
  })

  test('impersonating signs the admin in as the user with no proof to give, and stopping signs them back in as themselves', async () => {
    const { admin, ada, said, told, store } = await setup()

    expect(await admin.browser.call('impersonate', ada.id)).toEqual({ ok: true })
    expect(await admin.browser.json('/me')).toMatchObject({ email: 'ada@example.com' })
    expect(await admin.browser.call('impersonator')).toMatchObject({ email: 'root@example.com' })
    expect(await ada.browser.call('impersonator')).toBeFalsy()
    expect(await admin.browser.call('reprove', { password: PASSWORD })).toEqual({ ok: false, error: 'impersonating' })
    expect(await admin.browser.call('listUsers')).toEqual({ ok: false, error: 'forbidden' })
    expect(await ada.browser.call('sessions')).toHaveLength(2)

    expect(await admin.browser.call('stopImpersonating')).toBe(true)
    expect(await admin.browser.json('/me')).toMatchObject({ email: 'root@example.com' })
    expect(await admin.browser.call('impersonator')).toBeFalsy()
    expect(await admin.browser.call('stopImpersonating')).toBe(false)
    expect(await store.sessions.listByUser(ada.id)).toHaveLength(1)
    expect(said()).toEqual([['impersonation-started', 'ada@example.com', undefined, 'root@example.com'], ['impersonation-ended', 'ada@example.com', undefined, 'root@example.com']])
    expect(told()).toEqual([['impersonation-started', 'ada@example.com', {}, 'root@example.com'], ['impersonation-ended', 'ada@example.com', {}, 'root@example.com']])
  })

  test('another admin, themselves or a banned user cannot be impersonated', async () => {
    const { admin, ada, member } = await setup()
    const other = await member('second@example.com', ['admin'])

    expect(await admin.browser.call('impersonate', other.id)).toEqual({ ok: false, error: 'admin' })
    expect(await admin.browser.call('impersonate', admin.id)).toEqual({ ok: false, error: 'self' })
    expect(await admin.browser.call('impersonate', 'missing')).toEqual({ ok: false, error: 'not-found' })

    await admin.browser.post('/ban', { id: ada.id })

    expect(await admin.browser.call('impersonate', ada.id)).toEqual({ ok: false, error: 'banned' })
  })

  test('an impersonation ends once the admin is no longer one', async () => {
    const { admin, ada, store } = await setup()

    await admin.browser.call('impersonate', ada.id)
    await store.users.update(admin.id, { roles: [] })

    expect(await admin.browser.json('/me')).toBe('anonymous')
  })

  test('signing out while impersonating ends the admin\'s own sign-in too', async () => {
    const { admin, ada, store, said } = await setup()

    await admin.browser.call('impersonate', ada.id)
    await admin.browser.fetch('/sign-out', { method: 'POST' })

    expect(await admin.browser.json('/me')).toBe('anonymous')
    expect(await store.sessions.listByUser(admin.id)).toEqual([])
    expect(await store.sessions.listByUser(ada.id)).toHaveLength(1)
    expect(said().at(-1)).toEqual(['impersonation-ended', 'ada@example.com', undefined, 'root@example.com'])
  })

  test('the audit log of everyone, or of one user, with who acted', async () => {
    const { admin, ada } = await setup({ audit: true })

    setSystemTime(new Date(Date.now() + 1000))
    await admin.browser.call('grantRole', ada.id, 'editor')

    const everyone = await admin.browser.callOk('adminAuditLog')
    const hers = await admin.browser.callOk('adminAuditLog', { userId: ada.id, limit: 1 })

    expect(new Set(everyone.entries.map((entry: { userId: string }) => entry.userId))).toEqual(new Set([admin.id, ada.id]))
    expect(hers.entries).toEqual([expect.objectContaining({ event: 'role-granted', detail: 'editor', actorId: admin.id })])
  })
})
