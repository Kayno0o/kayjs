import type { User } from '../src/auth'
import type { AuthEventInfo } from '../src/events'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { memoryAuth } from '../src/memoryStore'
import { PRUNE_EVERY_MS } from '../src/prune'
import { testApp } from './helpers/app'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const DAY_MS = 24 * 60 * 60 * 1000
const LINKS = { 'verify-email': '/v', 'reset-password': '/r', 'magic-link': '/m', 'change-email': '/c' }

afterEach(() => {
  setSystemTime()
})

async function setup(options: { refuse?: () => boolean } = {}) {
  const mails = mailbox()
  const deleted: string[] = []
  const heard: AuthEventInfo[] = []
  const app = testApp({
    site: 'https://site.test',
    name: 'Site',
    audit: true,
    account: { deleteAfter: '14d', cancelPage: '/account/data' },
    email: { mailer: mails.mailer, links: LINKS, requireVerified: false },
    onEvent: (info) => {
      heard.push(info)
    },
    beforeDelete: ({ user }: { user: User }) => {
      if (options.refuse?.())
        return false

      deleted.push(user.id)

      return undefined
    },
  })
  const ada = app.browser()
  const { user } = await ada.callHas('user', 'password.register', { email: 'ada@example.com', password: PASSWORD })

  await app.store.users.update(user.id, { emailVerifiedAt: new Date() })

  const start = Date.now()
  // A visit `age` after the start runs the prune in the background, which `pruned` waits for.
  const prune = async (age: number) => {
    setSystemTime(start + age)
    await app.browser().json('/me')
    await app.pruned()
  }

  mails.mails.length = 0
  heard.length = 0

  return { ...app, ...mails, ada, user, deleted, heard, start, prune }
}

describe('a grace period before an account is deleted', () => {
  test('account.delete marks the account pending, mails the cancel link and leaves it signed in, calling nothing of the real deletion', async () => {
    const { ada, user, store, mails, deleted, heard } = await setup()
    const before = Date.now()
    const answer = await ada.callOk('account.delete', { password: PASSWORD })

    expect(new Date(answer.deleteAt!).getTime()).toBeGreaterThanOrEqual(before + 14 * DAY_MS)

    const record = await store.users.get(user.id)

    expect(record?.deleteAt).toEqual(new Date(answer.deleteAt!))
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })
    expect(await ada.call('account.deletion')).toEqual({ deleteAt: answer.deleteAt! })
    expect(deleted).toEqual([])

    expect(mails.map(mail => [mail.kind, mail.to, mail.url])).toEqual([['cancel-deletion', 'ada@example.com', 'https://site.test/account/data']])
    expect(mails[0]!.detail).toBeTruthy()
    expect(heard.map(info => info.event)).toEqual(['account-deletion-scheduled'])
    expect(heard[0]).toMatchObject({ event: 'account-deletion-scheduled', deleteAt: new Date(answer.deleteAt!) })
    expect((await store.audit!.list({ userId: user.id, limit: 10 })).map(entry => entry.event)).toContain('account-deletion-scheduled')
  })

  test('deleting again keeps the first deadline and mails nothing more', async () => {
    const { ada, mails } = await setup()
    const first = await ada.callOk('account.delete', { password: PASSWORD })
    const count = mails.length
    const second = await ada.callOk('account.delete', { password: PASSWORD })

    expect(second.deleteAt).toBe(first.deleteAt)
    expect(mails.length).toBe(count)
  })

  test('the proof is still asked before anything is marked', async () => {
    const { ada, user, store } = await setup()

    expect(await ada.call('account.delete', { password: 'wrong password!' })).toMatchObject({ ok: false, error: { code: 'proof' } })
    expect((await store.users.get(user.id))?.deleteAt ?? null).toBeNull()
  })

  test('cancelling takes the mark off, tells the user and the app, and the prune leaves the account', async () => {
    const { ada, user, store, mails, deleted, heard, prune } = await setup()

    await ada.callOk('account.delete', { password: PASSWORD })
    mails.length = 0
    heard.length = 0

    expect(await ada.call('account.cancelDeletion')).toEqual({ ok: true })
    expect((await store.users.get(user.id))?.deleteAt).toBeNull()
    expect(await ada.call('account.deletion')).toBeFalsy()
    expect(mails.map(mail => mail.kind)).toEqual(['account-deletion-cancelled'])
    expect(heard.map(info => info.event)).toEqual(['account-deletion-cancelled'])
    expect(await ada.call('account.cancelDeletion')).toMatchObject({ ok: false, error: { code: 'not-pending' } })

    await prune(15 * DAY_MS + PRUNE_EVERY_MS)

    expect(await store.users.get(user.id)).toBeDefined()
    expect(deleted).toEqual([])
  })

  test('the cancel route takes the mark off and goes where redirect says, a cross-site post being refused', async () => {
    const { ada, user, store } = await setup()
    const post = async (headers: Record<string, string> = {}) => ada.fetch('/auth/cancel-deletion', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ redirect: '/account/data' }) })

    await ada.callOk('account.delete', { password: PASSWORD })

    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await store.users.get(user.id))?.deleteAt).not.toBeNull()

    const answer = await post()

    expect(answer.status).toBe(303)
    expect(answer.headers.get('location')).toBe('/account/data')
    expect((await store.users.get(user.id))?.deleteAt).toBeNull()
  })

  test('the prune deletes the account once the period ends: beforeDelete, the audit log, onEvent and the notice follow that moment', async () => {
    const { ada, user, store, mails, deleted, heard, prune } = await setup()

    await ada.callOk('account.delete', { password: PASSWORD })
    mails.length = 0
    heard.length = 0
    await prune(13 * DAY_MS)

    expect(await store.users.get(user.id)).toBeDefined()
    expect(deleted).toEqual([])
    expect(mails).toEqual([])

    await prune(14 * DAY_MS + PRUNE_EVERY_MS)

    expect(await store.users.get(user.id)).toBeUndefined()
    expect(deleted).toEqual([user.id])
    expect(mails.map(mail => [mail.kind, mail.to])).toEqual([['account-deleted', 'ada@example.com']])
    expect(heard.map(info => info.event)).toContain('account-deleted')
    expect((await store.audit!.list({ limit: 50 })).filter(entry => entry.event === 'account-deleted').map(entry => [entry.userId === user.id, entry.ip])).toEqual([[false, '']])
  })

  test('a beforeDelete that refuses keeps the account pending, to be tried again', async () => {
    let refuse = true
    const { ada, user, store, deleted, prune } = await setup({ refuse: () => refuse })

    await ada.callOk('account.delete', { password: PASSWORD })
    await prune(15 * DAY_MS)

    expect(await store.users.get(user.id)).toBeDefined()
    expect(deleted).toEqual([])

    refuse = false
    await prune(15 * DAY_MS + 2 * PRUNE_EVERY_MS)

    expect(await store.users.get(user.id)).toBeUndefined()
    expect(deleted).toEqual([user.id])
  })
})

describe('without account.deleteAfter', () => {
  test('the deletion is immediate and nothing is pending', async () => {
    const app = testApp()
    const ada = app.browser()
    const { user } = await ada.callHas('user', 'password.register', { email: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('account.deletion')).toBeFalsy()
    expect(await ada.call('account.cancelDeletion')).toMatchObject({ ok: false, error: { code: 'not-pending' } })
    expect(await ada.call('account.delete', { password: PASSWORD })).toEqual({ ok: true })
    expect(await app.store.users.get(user.id)).toBeUndefined()
  })

  test('a store that cannot list the accounts due, or no page to cancel on, is refused at boot', () => {
    const store = memoryAuth()

    delete store.users.dueForDeletion

    expect(() => testApp({ store, account: { deleteAfter: '14d', cancelPage: '/x' } })).toThrow('dueForDeletion')
    expect(() => testApp({ account: { deleteAfter: '14d' } })).toThrow('cancelPage')
    expect(() => testApp({ pages: true, account: { deleteAfter: '14d' } })).not.toThrow()
  })
})
