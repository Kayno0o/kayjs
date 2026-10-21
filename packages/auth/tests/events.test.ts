import type { AuthEvent, AuthEventInfo } from '../src/events'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { eventFields } from '../src/events'
import { totpCode, totpStep } from '../src/totp'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const ACTIVITY = new Set<AuthEvent>(['signed-in', 'signed-out', 'sign-in-failed'])
// Where kay sends what libraries log through `logFrom`, as the app's `log` setting says.
const LOG_SINK = Symbol.for('kay.log')

afterEach(() => {
  setSystemTime()
})

function setup(options: Parameters<typeof testApp>[0] = {}) {
  const events: AuthEventInfo[] = []
  const app = testApp({
    onAuthEvent: (info) => {
      events.push(info)
    },
    ...options,
  })

  return { ...app, events }
}

function from(address: string, body: unknown) {
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': address, 'user-agent': 'Firefox' }, body: JSON.stringify(body) }
}

describe('onAuthEvent', () => {
  function listen(options: Parameters<typeof testApp>[0] = {}) {
    const heard: AuthEventInfo[] = []
    const app = testApp({ onAuthEvent: (info) => {
      heard.push(info)
    }, ...options })
    // The event and its fields, who it happened to and where from set aside.
    const said = () => heard.filter(info => ACTIVITY.has(info.event) || info.event === 'signed-out-everywhere').map(({ event, user: _user, context: _context, ...fields }) => [event, fields])

    return { ...app, heard, said }
  }

  test('hears one object, with how a sign-in happened and which attempt failed as fields, and where it came from', async () => {
    const { browser, said, heard } = listen()

    await browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    await browser().json('/password', from('10.0.0.1', { identifier: 'ada@example.com', password: 'wrong password' }))

    const ada = browser()

    await ada.json('/password', from('10.0.0.2', { identifier: 'ada@example.com', password: PASSWORD }))
    await ada.fetch('/sign-out', { method: 'POST' })
    await ada.json('/password', from('10.0.0.2', { identifier: 'ada@example.com', password: PASSWORD }))
    await ada.fetch('/sign-out-everywhere?keep=1', { method: 'POST' })
    await ada.fetch('/sign-out-everywhere', { method: 'POST' })

    expect(said()).toEqual([
      ['signed-in', { method: 'register' }],
      ['sign-in-failed', { method: 'password' }],
      ['signed-in', { method: 'password' }],
      ['signed-out', {}],
      ['signed-in', { method: 'password' }],
      ['signed-out-everywhere', { keptThisOne: true }],
      ['signed-out-everywhere', { keptThisOne: false }],
    ])
    expect(heard.find(info => info.event === 'sign-in-failed')).toMatchObject({ user: { email: 'ada@example.com' }, context: { ip: '10.0.0.1', userAgent: 'Firefox', actor: null } })
  })

  test('hears a failed second factor', async () => {
    const { browser, said, store } = listen()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    const { setup: totp } = await ada.callOk('setUpTwoFactor', { password: PASSWORD })

    await ada.call('enableTwoFactor', await totpCode(totp.secret, totpStep()))
    await store.users.update((await store.users.findByEmail('ada@example.com'))!.id, { totpLastStep: 0 })

    const phone = browser()

    await phone.post('/password', { identifier: 'ada@example.com', password: PASSWORD })
    await phone.call('verifyTwoFactor', '000000')

    expect(said().at(-1)).toEqual(['sign-in-failed', { method: 'two-factor' }])
  })

  test('an onAuthEvent that throws is logged, and the sign-in goes on', async () => {
    const { browser } = testApp({
      onAuthEvent: () => {
        throw new Error('down')
      },
    })
    const ada = browser()
    const logged: unknown[][] = []
    const global = globalThis as { [LOG_SINK]?: unknown }
    const sink = global[LOG_SINK]

    global[LOG_SINK] = (...args: unknown[]) => logged.push(args)

    try {
      await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    }
    finally {
      global[LOG_SINK] = sink
    }

    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })
    expect(logged).toContainEqual(['error', expect.stringMatching(/^onAuthEvent failed for /), expect.objectContaining({ message: 'down' }), undefined, 'kayjs-auth'])
  })

  test('reads the fields of every kind of event off its detail', () => {
    const fields: Record<AuthEvent, [detail: string | undefined, fields: object][]> = {
      'signed-in': [['password', { method: 'password' }], ['oauth:github', { method: 'oauth', provider: 'github' }], ['guest', { method: 'guest' }]],
      'signed-out': [[undefined, {}]],
      'sign-in-failed': [['passkey', { method: 'passkey' }], ['two-factor', { method: 'two-factor' }]],
      'role-granted': [['editor', { role: 'editor' }]],
      'role-revoked': [['editor', { role: 'editor' }]],
      'banned': [['spam', { reason: 'spam' }], [undefined, {}]],
      'unbanned': [[undefined, {}]],
      'impersonation-started': [[undefined, {}]],
      'impersonation-ended': [[undefined, {}]],
      'organization-created': [['org1', { organizationId: 'org1' }]],
      'organization-deleted': [['org1', { organizationId: 'org1' }]],
      'member-joined': [['org1 admin member', { organizationId: 'org1', roles: ['admin', 'member'] }], ['org1 ', { organizationId: 'org1', roles: [] }]],
      'member-left': [['org1', { organizationId: 'org1' }]],
      'member-removed': [['org1', { organizationId: 'org1' }]],
      'member-roles-changed': [['org1 owner', { organizationId: 'org1', roles: ['owner'] }]],
      'oauth-client-approved': [['Claude Code', { client: 'Claude Code' }]],
      'oauth-client-revoked': [['Claude Code', { client: 'Claude Code' }]],
      'new-sign-in': [[undefined, {}]],
      'sign-in-locked': [[undefined, {}]],
      'password-changed': [[undefined, {}]],
      'email-changed': [['ada@new.test', { email: 'ada@new.test' }]],
      'two-factor-enabled': [[undefined, {}]],
      'two-factor-disabled': [[undefined, {}]],
      'recovery-code-used': [[undefined, {}]],
      'recovery-codes-regenerated': [[undefined, {}]],
      'provider-linked': [['github', { provider: 'github' }]],
      'provider-unlinked': [['github', { provider: 'github' }]],
      'passkey-added': [['Laptop', { name: 'Laptop' }]],
      'passkey-removed': [['Laptop', { name: 'Laptop' }]],
      'token-created': [['CI', { name: 'CI' }]],
      'signed-out-everywhere': [['this-one-kept', { keptThisOne: true }], [undefined, { keptThisOne: false }]],
      'account-deleted': [[undefined, {}]],
      'organization-handed-over': [['org1', { organizationId: 'org1' }]],
    }

    for (const [event, cases] of Object.entries(fields)) {
      for (const [detail, expected] of cases)
        expect(eventFields(event as AuthEvent, detail)).toEqual(expected)
    }
  })
})

describe('the audit log', () => {
  test('keeps every event of the user\'s, read back newest first by the user only', async () => {
    const { browser } = setup({ audit: true })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.call('changePassword', { password: PASSWORD }, 'a brand new password')

    const bob = browser()

    await bob.call('register', { email: 'bob@example.com', password: PASSWORD })

    const log = await ada.call('listAuditLog')

    expect(log.map((entry: { event: string }) => entry.event)).toEqual(['password-changed', 'signed-in'])
    expect(log[0]).toMatchObject({ detail: null, ip: 'unknown', actorId: null })
    expect(await ada.call('listAuditLog', { limit: 1 })).toHaveLength(1)
    expect(await browser().call('listAuditLog')).toEqual([])
  })

  test('pages by the last entry of a page, also after a JSON hop', async () => {
    const { browser } = setup({ audit: true })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    setSystemTime(new Date(Date.now() + 1000))
    await ada.call('changePassword', { password: PASSWORD }, 'a brand new password')

    const first = (await ada.call('listAuditLog', { limit: 1 }))[0]!
    const next = await ada.call('listAuditLog', { limit: 1, before: JSON.parse(JSON.stringify(first)) })

    expect(first.event).toBe('password-changed')
    expect(next.map((entry: { event: string }) => entry.event)).toEqual(['signed-in'])
    expect(await ada.call('listAuditLog', { before: JSON.parse(JSON.stringify(next[0])) })).toEqual([])
    expect((await ada.call('listAuditLog', { before: JSON.parse(JSON.stringify(new Date(first.at))) })).map((entry: { event: string }) => entry.event)).toEqual(['signed-in'])
  })

  test('answers an empty page for a cursor that is no date', async () => {
    const { browser } = setup({ audit: true })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    for (const before of [new Date(Number.NaN), null, 'soon', 12, { at: 'soon', id: 'x' }, { at: new Date().toISOString() }])
      expect(await ada.post('/call/auditLog', [{ before }])).toEqual([])
  })

  test('reads entries of one millisecond newest written first', async () => {
    const { browser, store } = setup({ audit: true })
    const ada = browser()

    setSystemTime(new Date())
    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    let current = PASSWORD

    for (let index = 0; index < 20; index++) {
      const next = `a brand new password ${index}`

      await ada.call('changePassword', { password: current }, next)
      current = next
    }
    const entries = await store.audit!.list({ limit: 100 })

    expect(new Set(entries.map(entry => entry.at.getTime())).size).toBe(1)
    expect(entries.filter(entry => entry.event === 'password-changed')).toHaveLength(20)
    expect(entries.map(entry => entry.id)).toEqual(entries.map(entry => entry.id).toSorted().toReversed())
    expect(entries.at(-1)!.event).toBe('signed-in')
  })

  test('is not kept without the option', async () => {
    const { browser, store } = setup()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('listAuditLog')).toEqual([])
    expect(await store.audit!.list({ limit: 10 })).toEqual([])
  })

  test('forgets what is older than its age, an hour at most after', async () => {
    const { browser, store } = setup({ audit: { maxAge: '60s' } })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000))
    await ada.fetch('/sign-out', { method: 'POST' })

    expect((await store.audit!.list({ limit: 10 })).map(entry => entry.event)).toEqual(['signed-out'])
  })
})

describe('impersonation', () => {
  test('what an admin does as a user names the admin as the actor, to `onAuthEvent` and in the audit log', async () => {
    const { browser, store, events } = setup({ admin: 'admin', audit: true, organizations: { roles: { owner: ['admin'], admin: ['member'], member: [] }, owner: 'owner', manage: 'admin' } })
    const ada = browser()
    const root = browser()
    const { user } = await ada.callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })
    const { user: admin } = await root.callHas('user', 'register', { email: 'root@example.com', password: PASSWORD })

    await store.users.update(admin.id, { roles: ['admin'] })
    await ada.call('createOrganization', { name: 'Acme' })
    await root.call('impersonate', user.id)
    await root.call('createOrganization', { name: 'Support' })
    await root.fetch('/sign-out-everywhere?keep=1', { method: 'POST' })
    await root.call('stopImpersonating')

    const heard = events.filter(entry => ['organization-created', 'signed-out-everywhere', 'impersonation-started', 'impersonation-ended'].includes(entry.event)).map(entry => [entry.event, entry.user.email, entry.context.actor?.email ?? null])

    expect(heard).toEqual([
      ['organization-created', 'ada@example.com', null],
      ['impersonation-started', 'ada@example.com', 'root@example.com'],
      ['organization-created', 'ada@example.com', 'root@example.com'],
      ['signed-out-everywhere', 'ada@example.com', 'root@example.com'],
      ['impersonation-ended', 'ada@example.com', 'root@example.com'],
    ])

    const logged = (await store.audit!.list({ userId: user.id, limit: 50 })).filter(entry => entry.event === 'organization-created').map(entry => entry.actorId)

    expect(logged.sort()).toEqual([admin.id, null].sort())
  })

  test('an admin acting as a user neither deletes their organizations nor downloads their data', async () => {
    const { browser, store } = setup({ admin: 'admin', organizations: { roles: { owner: ['admin'], admin: ['member'], member: [] }, owner: 'owner', manage: 'admin' } })
    const ada = browser()
    const root = browser()
    const { user } = await ada.callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })
    const { user: admin } = await root.callHas('user', 'register', { email: 'root@example.com', password: PASSWORD })

    await store.users.update(admin.id, { roles: ['admin'] })
    const { membership } = await ada.callOk('createOrganization', { name: 'Acme' })

    await root.call('impersonate', user.id)

    expect(await root.call('deleteOrganization', membership.organization.id)).toEqual({ ok: false, error: 'impersonating' })
    expect(await root.call('exportData')).toEqual({ ok: false, error: 'impersonating' })
    expect((await root.fetch('/auth/export')).status).toBe(403)
    expect(await ada.call('getOrganization', membership.organization.id)).toMatchObject({ organization: { name: 'Acme' } })
  })
})
