import type { MailingSubscription } from '../src/mail'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { notifications, notify } from 'kay/server'
import { PRUNE_EVERY_MS } from '../src/prune'
import { testApp, userRecord } from './helpers/app'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const LINKS = { 'magic-link': '/magic', 'verify-email': '/verify', 'reset-password': '/reset', 'change-email': '/change' }
const DAY_MS = 24 * 60 * 60 * 1000

afterEach(() => {
  setSystemTime()
})

// A mailer standing for kayjs-mail's: it keeps what it is sent and answers `erase` and `subscriptions` as the mailer does.
function listing() {
  const { mailer, mails } = mailbox()
  const erased: string[] = []
  const lists = new Map<string, MailingSubscription[]>([['ada@example.com', [{ list: 'news', status: 'confirmed', askedAt: new Date(1000), confirmedAt: new Date(2000) }, { list: 'offers', status: 'pending', askedAt: new Date(3000), confirmedAt: null }]]])

  return {
    mails,
    erased,
    mailer: {
      ...mailer,
      erase: (address: string) => {
        erased.push(address)
        lists.delete(address)
      },
      subscriptions: async (address: string) => lists.get(address) ?? [],
    },
  }
}

async function setup() {
  const mail = listing()
  const app = testApp({ admin: 'admin', guests: { maxAge: '1d' }, url: 'http://localhost', email: { mailer: mail.mailer, links: LINKS, requireVerified: false } })
  const ada = app.browser()
  const { user } = await ada.callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })

  await notify(user.id, { title: 'Welcome' })

  return { ...app, ...mail, ada, user }
}

describe('erasing a user takes their notifications and mailing list rows', () => {
  test('by themselves', async () => {
    const { ada, user, erased } = await setup()

    expect(await notifications.list(user.id)).toHaveLength(1)
    expect(await ada.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
    expect(await notifications.list(user.id)).toEqual([])
    expect(erased).toEqual(['ada@example.com'])
  })

  test('by an admin', async () => {
    const { browser, store, user, erased } = await setup()
    const admin = browser()
    const { user: boss } = await admin.callHas('user', 'register', { email: 'boss@example.com', password: PASSWORD })

    await store.users.update(boss.id, { roles: ['admin'] })
    expect(await admin.call('deleteUser', user.id)).toEqual({ ok: true })
    expect(await notifications.list(user.id)).toEqual([])
    expect(erased).toEqual(['ada@example.com'])
  })

  test('by the prune of a guest, whose notifications go and whose unproved address is left on its lists', async () => {
    const { browser, store, erased } = await setup()
    const start = Date.now()

    await store.users.create(userRecord({ id: 'stale', guest: true, email: 'guest@example.com', createdAt: new Date(start - 1000) }))
    await notify('stale', { title: 'Hello guest' })
    setSystemTime(start + DAY_MS + PRUNE_EVERY_MS)
    await browser().json('/me')
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(await store.users.get('stale')).toBeUndefined()
    expect(await notifications.list('stale')).toEqual([])
    expect(erased).toEqual([])
  })

  test('a failing mailer leaves the account in place, to delete again', async () => {
    const { ada, store, mailer } = await setup()
    let fail = true
    const erase = mailer.erase

    mailer.erase = (address) => {
      if (fail)
        throw new Error('lists down')

      erase(address)
    }

    expect((await ada.fetch('/call/deleteAccount', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ password: PASSWORD }]) })).status).toBe(500)
    expect(await store.users.findByEmail('ada@example.com')).toBeDefined()
    fail = false
    expect(await ada.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
  })

  test('without a mailer that erases, only the notifications go', async () => {
    const app = testApp({ url: 'http://localhost', email: { mailer: mailbox().mailer, links: LINKS, requireVerified: false } })
    const ada = app.browser()
    const { user } = await ada.callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })

    await notify(user.id, { title: 'Welcome' })
    expect(await ada.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })
    expect(await notifications.list(user.id)).toEqual([])
  })
})

describe('the export lists them', () => {
  test('notifications and mailing lists, pending ones included', async () => {
    const { ada } = await setup()
    const exported = await ada.callOk('exportData')

    expect(exported.data.notifications).toMatchObject([{ title: 'Welcome', read: false }])
    expect(exported.data.mailingLists).toMatchObject([{ list: 'news', status: 'confirmed' }, { list: 'offers', status: 'pending', confirmedAt: null }])
  })

  test('are empty without a mailer that lists', async () => {
    const app = testApp({ url: 'http://localhost', email: { mailer: mailbox().mailer, links: LINKS, requireVerified: false } })
    const ada = app.browser()

    await ada.callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })

    const exported = await ada.callOk('exportData')

    expect(exported.data.notifications).toEqual([])
    expect(exported.data.mailingLists).toEqual([])
  })
})
