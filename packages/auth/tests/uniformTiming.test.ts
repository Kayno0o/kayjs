import type { Mail } from '../src/mail'
import * as utils from '@kaynooo/utils'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { SECRET, testApp } from './helpers/app'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const WRONG = 'wrong password!'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }
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
    await Bun.sleep(1500)

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
  for (const hook of ['onAuthEvent', 'onEvent'] as const) {
    test(`a failed password sign-in does not wait for ${hook}, held address or not`, async () => {
      const slow = gate()
      let armed = false
      const app = testApp({ [hook]: async () => {
        if (armed)
          await slow.closed
      } })

      await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })
      armed = true

      for (const identifier of ['ada@example.com', 'nobody@example.com'])
        expect(await finishes(app.browser().json('/password', from('10.0.0.1', { identifier, password: WRONG })))).toBe('done')

      slow.open()
    })
  }

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
    const app = testApp({ audit: true, onEvent: (event) => {
      heard.push(event)
    } })

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    await app.browser().json('/password', from('10.0.0.1', { identifier: 'ada@example.com', password: WRONG }))
    await Bun.sleep(20)

    expect(heard).toContain('sign-in-failed')
    expect((await app.store.audit!.list({ limit: 10 })).map(entry => entry.event)).toContain('sign-in-failed')
  })

  test('a throwing hook after the request is over is logged, not raised', async () => {
    const app = testApp({ onAuthEvent: () => {
      throw new Error('hook down')
    } })

    await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })
    expect(await app.browser().json('/password', from('10.0.0.1', { identifier: 'ada@example.com', password: WRONG }))).toEqual({ ok: false, error: 'invalid' })
  })

  test('the lockout answer does not wait on the holder\'s notice, held address or not', async () => {
    const slow = gate()
    const box = mailbox()
    const app = testApp({ limits: { signInAccountAll: { max: 1, window: 900 } }, url: 'https://site.test', email: { mailer: box.mailer, links: LINKS, requireVerified: false }, onAuthEvent: async (info) => {
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
