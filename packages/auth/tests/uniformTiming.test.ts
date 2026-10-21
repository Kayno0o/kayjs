import type { Mail } from '../src/mail'
import * as utils from '@kaynooo/utils'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { SECRET, testApp } from './helpers/app'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const WRONG = 'wrong password!'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }
// Where kay sends what libraries log through `logFrom`.
const LOG_SINK = Symbol.for('kay.log')
const JSON_POST = { 'content-type': 'application/json' }

afterEach(() => {
  spyOn(utils, 'comparePasswords').mockRestore()
  spyOn(utils, 'hashPassword').mockRestore()
})

// Settles with `'done'` as soon as `work` does, or `'stuck'` when it has not by then: a request that waits on something held back never finishes, and a request that does not wait finishes within a few ticks.
async function finishes(work: Promise<unknown>): Promise<'done' | 'stuck'> {
  const done = (async () => {
    await work

    return 'done' as const
  })()
  const stuck = (async () => {
    await Bun.sleep(5000)

    return 'stuck' as const
  })()

  return Promise.race([done, stuck])
}

// A gate a test holds shut so that whatever waits on it shows.
function gate() {
  let open!: () => void
  const closed = new Promise<void>((resolve) => {
    open = resolve
  })

  return { closed, open }
}

function from(address: string, body: unknown) {
  return { method: 'POST', headers: { ...JSON_POST, 'x-forwarded-for': address }, body: JSON.stringify(body) }
}

describe('sign-in answers in the same time for a held address and a free one', () => {
  test('a failed password sign-in does not wait for onAuthEvent, held address or not', async () => {
    const slow = gate()
    let armed = false
    const app = testApp({ onAuthEvent: async () => {
      if (armed)
        await slow.closed
    } })

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    armed = true

    for (const identifier of ['ada@example.com', 'nobody@example.com'])
      expect(await finishes(app.browser().json('/password', from('10.0.0.1', { identifier, password: WRONG })))).toBe('done')

    slow.open()
  })

  test('a failed password sign-in does not wait for the audit log write, held address or not', async () => {
    const app = testApp({ audit: true })

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })

    const slow = gate()
    const add = app.store.audit!.add.bind(app.store.audit)

    app.store.audit!.add = async (entry) => {
      await slow.closed
      await add(entry)
    }

    for (const identifier of ['ada@example.com', 'nobody@example.com'])
      expect(await finishes(app.browser().json('/password', from('10.0.0.1', { identifier, password: WRONG })))).toBe('done')

    slow.open()
  })

  test('the event of a failed sign-in is still reported once the request is over', async () => {
    const heard: string[] = []
    const app = testApp({ audit: true, onAuthEvent: ({ event }) => {
      heard.push(event)
    } })

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    await app.browser().json('/password', from('10.0.0.1', { identifier: 'ada@example.com', password: WRONG }))

    // Reported after the response: polled for, with room for a busy host.
    for (let waited = 0; waited < 5000 && !(heard.includes('sign-in-failed') && (await app.store.audit!.list({ limit: 10 })).some(entry => entry.event === 'sign-in-failed')); waited += 10)
      await Bun.sleep(10)

    expect(heard).toContain('sign-in-failed')
    expect((await app.store.audit!.list({ limit: 10 })).map(entry => entry.event)).toContain('sign-in-failed')
  })

  test('a throwing hook after the response is logged, not raised', async () => {
    const app = testApp({ onAuthEvent: (info) => {
      if (info.event === 'sign-in-failed')
        throw new Error('hook down')
    } })

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })

    const logged: unknown[][] = []
    const global = globalThis as { [LOG_SINK]?: unknown }
    const sink = global[LOG_SINK]

    global[LOG_SINK] = (...args: unknown[]) => logged.push(args)

    try {
      expect(await app.browser().json('/password', from('10.0.0.1', { identifier: 'ada@example.com', password: WRONG }))).toEqual({ ok: false, error: 'invalid' })

      for (let waited = 0; waited < 5000 && logged.length === 0; waited += 10)
        await Bun.sleep(10)
    }
    finally {
      global[LOG_SINK] = sink
    }

    expect(logged).toContainEqual(['error', 'onAuthEvent failed for sign-in-failed', expect.objectContaining({ message: 'hook down' }), undefined, 'kayjs-auth'])
  })

  test('the lockout answer does not wait on the holder\'s notice, held address or not', async () => {
    const slow = gate()
    const box = mailbox()
    const app = testApp({ rateLimit: { signInAccountAll: { max: 1, window: '900s' } }, url: 'https://site.test', email: { mailer: box.mailer, links: LINKS, requireVerified: false }, onAuthEvent: async (info) => {
      if (info.event === 'sign-in-locked')
        await slow.closed
    } })

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    const user = (await app.store.users.findByEmail('ada@example.com'))!

    await app.store.users.update(user.id, { emailVerifiedAt: new Date() })

    for (const identifier of ['ada@example.com', 'nobody@example.com']) {
      await app.browser().json('/password', from('10.0.0.1', { identifier, password: WRONG }))
      expect(await finishes(app.browser().json('/password', from('10.0.0.2', { identifier, password: WRONG })))).toBe('done')
    }

    slow.open()
  })

  test('a wrong password is checked against a hash for a held address, a free one and an account without a password alike', async () => {
    const app = testApp()

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    await app.store.users.create({ ...(await app.store.users.findByEmail('ada@example.com'))!, id: 'nopass', email: 'nopass@example.com', passwordHash: null })

    const compare = spyOn(utils, 'comparePasswords')

    for (const identifier of ['ada@example.com', 'nobody@example.com', 'nopass@example.com']) {
      compare.mockClear()
      await app.browser().json('/password', from('10.0.0.1', { identifier, password: WRONG }))
      expect(compare).toHaveBeenCalledTimes(1)
    }
  })
})

describe('registering an address that is held', () => {
  test('hashes the password as a free address does, and does not wait on the holder\'s notice', async () => {
    const slow = gate()
    const sent: Mail[] = []
    const app = testApp({ url: 'https://site.test', email: { mailer: { send: async (mail) => {
      sent.push(mail)
      await slow.closed
    } }, links: LINKS } })

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })

    const hash = spyOn(utils, 'hashPassword')

    for (const email of ['ada@example.com', 'bob@example.com']) {
      hash.mockClear()
      expect(await finishes(app.browser().call('register', { email, password: PASSWORD }))).toBe('done')
      expect(hash).toHaveBeenCalledTimes(1)
    }

    slow.open()
  })
})

describe('registering under requireVerified', () => {
  test('does not wait on onSignUp or on the erase of a replaced unverified account, held address or free', async () => {
    const slow = gate()
    let armed = false
    const ran: string[] = []
    const app = testApp({ url: 'https://site.test', email: { mailer: { send: () => undefined }, links: LINKS }, onSignUp: async ({ user }) => {
      if (armed) {
        await slow.closed
        ran.push(`signed-up:${user.email}`)
      }
    }, onDelete: async ({ user }) => {
      if (armed) {
        await slow.closed
        ran.push(`deleted:${user.email}`)
      }
    } })

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    await app.browser().call('register', { email: 'grace@example.com', password: PASSWORD })
    await app.store.users.update((await app.store.users.findByEmail('grace@example.com'))!.id, { emailVerifiedAt: new Date() })
    armed = true

    for (const email of ['grace@example.com', 'ada@example.com', 'bob@example.com'])
      expect(await finishes(app.browser().call('register', { email, password: PASSWORD }))).toBe('done')

    expect(ran).toEqual([])
    slow.open()
    await Bun.sleep(50)

    expect(ran.toSorted()).toEqual(['deleted:ada@example.com', 'signed-up:ada@example.com', 'signed-up:bob@example.com'])
    expect((await app.store.users.findByEmail('ada@example.com'))?.id).toBeDefined()
    expect((await app.store.users.findByEmail('bob@example.com'))?.id).toBeDefined()
  })
})

describe('mail requests', () => {
  for (const method of ['requestPasswordReset', 'requestMagicLink'] as const) {
    test(`${method} does not wait on the mailer for a held address, and parks a code for a free one alike`, async () => {
      const slow = gate()
      const app = testApp({ url: 'https://site.test', email: { mailer: { send: async () => slow.closed }, links: LINKS, codes: 'both', requireVerified: false } })

      await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })

      for (const email of ['ada@example.com', 'nobody@example.com']) {
        const browser = app.browser()

        expect(await finishes(browser.call(method, email))).toBe('done')
        expect(await browser.call(method, email)).toEqual({ ok: true })
      }

      slow.open()
    })
  }
})

describe('confirming an address with a password', () => {
  test('an account without a password is checked against a hash as one with a password is', async () => {
    const box = mailbox()
    const app = testApp({ url: 'https://site.test', secret: SECRET, email: { mailer: box.mailer, links: LINKS } })

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    await app.browser().call('register', { email: 'bob@example.com', password: PASSWORD })

    const bob = (await app.store.users.findByEmail('bob@example.com'))!

    await app.store.users.update(bob.id, { passwordHash: null })

    const links = (await Promise.all([box.take({ to: 'ada@example.com', kind: 'verify-email' }), box.take({ to: 'bob@example.com', kind: 'verify-email' })])).flat().map(mail => new URL(mail.url!).searchParams.get('token')!)
    const compare = spyOn(utils, 'comparePasswords')

    for (const token of links) {
      compare.mockClear()
      await app.browser().call('verifyEmail', token, WRONG)
      expect(compare).toHaveBeenCalledTimes(1)
    }
  })
})

describe('a replaced unverified account whose erase fails', () => {
  test('stays listed as stale, so the sweep erases it later', async () => {
    let failing = true
    const app = testApp({ url: 'https://site.test', email: { mailer: { send: () => undefined }, links: LINKS }, onDelete: () => {
      if (failing)
        throw new Error('hook down')
    } })

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })

    const old = (await app.store.users.findByEmail('ada@example.com'))!

    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    await Bun.sleep(50)
    logged.mockRestore()
    failing = false

    expect(await app.store.users.get(old.id)).toBeDefined()
    expect((await app.store.users.staleUnverified!(new Date(Date.now() + 1000), 10)).map(user => user.id)).toContain(old.id)
  })
})
