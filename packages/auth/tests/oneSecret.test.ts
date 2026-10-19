import type { AuthSessionData } from '../src/auth'
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { session } from 'kay/server'
import { deriveKeys } from '../src/keys'
import { base32Encode, totpCode, totpStep } from '../src/totp'
import { sealTotpSecret } from '../src/twoFactor'
import { SECRET, testApp, userRecord } from './helpers/app'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }
const OLD = 'an-older-test-secret-that-is-long-enough-too'

describe('one secret for the session and kayjs-auth', () => {
  test('a purpose gives its own key, never the secret or the cookie key', () => {
    const sessions = session<AuthSessionData>({ secret: SECRET })
    const [a] = sessions.deriveSecret('a') as [string]
    const [b] = sessions.deriveSecret('b') as [string]

    expect(a).not.toBe(b)
    expect(a).not.toBe(SECRET)
    expect(a).not.toBe(createHash('sha256').update(SECRET).digest('base64url'))
    expect(a.length).toBeGreaterThanOrEqual(32)
    expect(sessions.deriveSecret('a')).toEqual([a])
  })

  test('a rotated list derives a list in the same order', () => {
    const rotated = session({ secret: [SECRET, OLD] }).deriveSecret('x')

    expect(rotated).toEqual([...session({ secret: SECRET }).deriveSecret('x'), ...session({ secret: OLD }).deriveSecret('x')])
  })

  test('a weak session secret still throws', () => {
    expect(() => session({ secret: 'short' })).toThrow()
  })

  test('auth without a secret takes it from the session and signs in', async () => {
    const sessions = session<AuthSessionData>({ secret: SECRET })
    const app = testApp({ sessions, secret: undefined })

    await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))

    const browser = app.browser()

    await browser.fetch('/sign-in/u1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(await (await browser.fetch('/me')).json()).toMatchObject({ id: 'u1' })
  })

  test('the derived secret keeps sealed values readable after the session rotates', () => {
    const before = deriveKeys(session({ secret: OLD }).deriveSecret('kayjs-auth'))
    const sealed = before.encrypt('totp', 'row')
    const after = deriveKeys(session({ secret: [SECRET, OLD] }).deriveSecret('kayjs-auth'))

    expect(after.decrypt(sealed, 'row')).toBe('totp')
  })

  // A second factor sealed under OLD opens only where `secret` is OLD, so the explicit secret is the one in use.
  test('an app\'s own secret wins over the session\'s', async () => {
    const secret = base32Encode(new TextEncoder().encode('a-plain-legacy-secret'))
    const attempt = async (options: { secret: string | undefined }) => {
      const app = testApp({ sessions: session<AuthSessionData>({ secret: SECRET }), url: 'https://site.test', email: { mailer: mailbox().mailer, links: LINKS, requireVerified: false }, ...options })

      await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })

      const user = (await app.store.users.findByEmail('ada@example.com'))!

      await app.store.users.update(user.id, { emailVerifiedAt: new Date(), totpSecret: sealTotpSecret(OLD, user.id, secret), totpEnabledAt: new Date() })

      const visitor = app.browser()

      await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

      return visitor.call('verifyTwoFactor', await totpCode(secret, totpStep()))
    }

    expect((await attempt({ secret: OLD })).ok).toBe(true)
    expect((await attempt({ secret: undefined })).ok).toBe(false)
  })

  test('a session plugin that cannot derive needs a secret', () => {
    expect(() => testApp({ sessions: { '~Ephemeral': { derive: {} } } as never, secret: undefined })).toThrow('secret')
  })
})
