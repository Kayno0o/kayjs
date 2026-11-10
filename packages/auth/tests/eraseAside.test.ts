import type { MailingSubscription } from '../src/mail'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { memoryPush, notifications, notify, personalData } from 'kay/server'
import { setupStore } from '../../../src/server/app-store'
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
  const app = testApp({ admin: 'admin', guests: { maxAge: '1d' }, site: 'http://localhost', email: { mailer: mail.mailer, links: LINKS, requireVerified: false } })
  const ada = app.browser()
  const { user } = await ada.callHas('user', 'password.register', { email: 'ada@example.com', password: PASSWORD })

  await app.store.users.update(user.id, { emailVerifiedAt: new Date() })
  await notify(user.id, { title: 'Welcome' })

  return { ...app, ...mail, ada, user }
}

describe('erasing a user takes their notifications and mailing list rows', () => {
  test('by themselves', async () => {
    const { ada, user, erased } = await setup()

    expect(await notifications.list(user.id)).toHaveLength(1)
    expect(await ada.call('account.delete', { password: PASSWORD })).toEqual({ ok: true })
    expect(await notifications.list(user.id)).toEqual([])
    expect(erased).toEqual(['ada@example.com'])
  })

  test('by an admin', async () => {
    const { browser, store, user, erased } = await setup()
    const admin = browser()
    const { user: boss } = await admin.callHas('user', 'password.register', { email: 'boss@example.com', password: PASSWORD })

    await store.users.update(boss.id, { roles: ['admin'] })
    expect(await admin.call('admin.deleteUser', user.id)).toEqual({ ok: true })
    expect(await notifications.list(user.id)).toEqual([])
    expect(erased).toEqual(['ada@example.com'])
  })

  // Visiting a day and an hour on runs the prune of stale guests in the background.
  async function pruned(guest: { id: string, email: string, verified: boolean }) {
    const context = await setup()
    const start = Date.now()

    await context.store.users.create(userRecord({ id: guest.id, guest: true, email: guest.email, emailVerifiedAt: guest.verified ? new Date() : null, createdAt: new Date(start - 1000) }))
    await notify(guest.id, { title: 'Hello guest' })
    setSystemTime(start + DAY_MS + PRUNE_EVERY_MS)
    await context.browser().json('/me')
    await context.pruned()
    expect(await context.store.users.get(guest.id)).toBeUndefined()
    expect(await notifications.list(guest.id)).toEqual([])

    return context.erased
  }

  test('by the prune of a guest, whose unproved address is left on the lists', async () => {
    expect(await pruned({ id: 'stale', email: 'guest@example.com', verified: false })).toEqual([])
  })

  test('by the prune of a guest with a verified address, which leaves the lists', async () => {
    expect(await pruned({ id: 'stale', email: 'guest@example.com', verified: true })).toEqual(['guest@example.com'])
  })

  test('by themselves with an address nobody proved, which stays on the lists', async () => {
    const { ada, user, store, erased } = await setup()

    await store.users.update(user.id, { emailVerifiedAt: null })
    expect(await ada.call('account.delete', { password: PASSWORD })).toEqual({ ok: true })
    expect(await notifications.list(user.id)).toEqual([])
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

    expect((await ada.fetch('/call/account.delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ password: PASSWORD }]) })).status).toBe(500)
    expect(await store.users.findByEmail('ada@example.com')).toBeDefined()
    fail = false
    expect(await ada.call('account.delete', { password: PASSWORD })).toEqual({ ok: true })
  })

  test('without a mailer that erases, only the notifications go', async () => {
    const app = testApp({ site: 'http://localhost', email: { mailer: mailbox().mailer, links: LINKS, requireVerified: false } })
    const ada = app.browser()
    const { user } = await ada.callHas('user', 'password.register', { email: 'ada@example.com', password: PASSWORD })

    await notify(user.id, { title: 'Welcome' })
    expect(await ada.call('account.delete', { password: PASSWORD })).toEqual({ ok: true })
    expect(await notifications.list(user.id)).toEqual([])
  })
})

describe('a source another library registered with kay', () => {
  const kept = new Map<string, string[]>([['ada', ['hello']]])

  function register(fail = false) {
    personalData.register({
      name: 'chats',
      erase: (user) => {
        if (fail)
          throw new Error('chats down')

        return kept.delete(user) ? 1 : 0
      },
      export: user => kept.get(user),
    })
  }

  afterEach(() => {
    personalData.unregister('chats')
    kept.set('ada', ['hello'])
  })

  test('is erased with the account and listed in the export under its name', async () => {
    register()

    const { ada, user } = await setup()

    kept.set(user.id, ['hello'])
    expect((await ada.callOk('account.export')).data.libraries).toEqual({ chats: ['hello'] })
    expect(await ada.call('account.delete', { password: PASSWORD })).toEqual({ ok: true })
    expect(kept.has(user.id)).toBe(false)
  })

  test('is erased by an admin deleting the user', async () => {
    register()

    const { browser, store, user } = await setup()
    const admin = browser()
    const { user: boss } = await admin.callHas('user', 'password.register', { email: 'boss@example.com', password: PASSWORD })

    kept.set(user.id, ['hello'])
    await store.users.update(boss.id, { roles: ['admin'] })
    expect(await admin.call('admin.deleteUser', user.id)).toEqual({ ok: true })
    expect(kept.has(user.id)).toBe(false)
  })

  test('failing leaves the account in place, to delete again', async () => {
    register(true)

    const { ada, store } = await setup()

    expect((await ada.fetch('/call/account.delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ password: PASSWORD }]) })).status).toBe(500)
    expect(await store.users.findByEmail('ada@example.com')).toBeDefined()
  })

  test('adds nothing to the export when it keeps nothing about the user', async () => {
    register()

    const { ada } = await setup()

    expect((await ada.callOk('account.export')).data.libraries).toEqual({})
  })
})

describe('the export lists them', () => {
  test('notifications and mailing lists, pending ones included', async () => {
    const { ada } = await setup()
    const exported = await ada.callOk('account.export')

    expect(exported.data.notifications).toMatchObject([{ title: 'Welcome', read: false }])
    expect(exported.data.mailingLists).toMatchObject([{ list: 'news', status: 'confirmed' }, { list: 'offers', status: 'pending', confirmedAt: null }])
  })

  test('push subscriptions, the user\'s own endpoints and dates only, no keys', async () => {
    const store = memoryPush()

    setupStore({ push: store })

    try {
      const { ada, user } = await setup()

      await store.add(user.id, { endpoint: 'https://push.example/ada', p256dh: 'p', auth: 'a', createdAt: 5000 }, 10)
      await store.add('someone-else', { endpoint: 'https://push.example/other', p256dh: 'p', auth: 'a', createdAt: 6000 }, 10)

      const exported = await ada.callOk('account.export')

      expect(exported.data.pushSubscriptions).toEqual([{ endpoint: 'https://push.example/ada', createdAt: new Date(5000).toISOString() }])
    }
    finally {
      setupStore(undefined)
    }
  })

  test('are empty without a mailer that lists', async () => {
    const app = testApp({ site: 'http://localhost', email: { mailer: mailbox().mailer, links: LINKS, requireVerified: false } })
    const ada = app.browser()

    await ada.callHas('user', 'password.register', { email: 'ada@example.com', password: PASSWORD })

    const exported = await ada.callOk('account.export')

    expect(exported.data.notifications).toEqual([])
    expect(exported.data.mailingLists).toEqual([])
    expect(exported.data.pushSubscriptions).toEqual([])
  })
})
