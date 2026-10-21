import type { Limits } from '../src/limits'
import { describe, expect, test } from 'bun:test'
import { DEFAULT_LIMITS } from '../src/limits'
import { base32Encode, totpCode, totpStep } from '../src/totp'
import { sealTotpSecret } from '../src/twoFactor'
import { SECRET, testApp, userRecord } from './helpers/app'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const WRONG = 'wrong password!'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }

interface Row {
  key: keyof typeof DEFAULT_LIMITS
  // Said when the limiter is reached from more than one action.
  action?: string
  // What the limiter counts: the account or address typed, or the client address.
  per: 'account' | 'client'
  // Overrides the default window and maximum, for a limiter too loose to walk in a test.
  limit?: { max: number, window: number }
  // What an attempt before the maximum is answered with, so the limit is not reached through some other refusal.
  answers: object
  // Sets the app up and answers an attempt that is not itself refused, the n-th of them.
  prepare: (limits: Partial<Limits>) => Promise<(n: number) => Promise<unknown>>
}

async function registered(limits: Partial<Limits>, extra: Parameters<typeof testApp>[0] = {}) {
  const app = testApp({ rateLimit: limits, ...extra })
  const ada = app.browser()

  await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

  return { ...app, ada }
}

// A visitor with the password of an account that asks for a code, enrolled straight in the store so no attempt is spent on the way.
async function pendingSignIn(limits: Partial<Limits>) {
  const app = await registered(limits)
  const secret = base32Encode(new TextEncoder().encode('a-plain-legacy-secret'))
  const [user] = (await app.store.users.list({ offset: 0, limit: 1 })).users

  await app.store.users.update(user!.id, { totpSecret: sealTotpSecret(SECRET, user!.id, secret), totpEnabledAt: new Date() })
  const visitor = app.browser()

  await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

  return { ...app, visitor, secret }
}

// The options of an app that mails, to a mailer nobody reads.
function mail(codes?: 'code') {
  return { url: 'https://site.test', email: { mailer: mailbox().mailer, links: LINKS, codes, requireVerified: false } }
}

async function mailed(limits: Partial<Limits>) {
  const app = testApp({ rateLimit: limits, ...mail() })

  await app.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', emailVerifiedAt: new Date() }))

  return app
}

async function secondFactor(limits: Partial<Limits>) {
  const app = await registered(limits)
  const { setup } = await app.ada.callOk('setUpTwoFactor', { password: PASSWORD })

  return { ...app, secret: setup.secret }
}

async function guessingCodes(limits: Partial<Limits>) {
  const { ada } = await registered(limits, mail('code'))

  await ada.call('requestMagicLink', 'ada@example.com')

  return async () => ada.call('signInWithEmailCode', '000000')
}

// Every limiter that guards one action and is walked here: attempts up to the maximum are answered, the next one is `limited`.
const rows: Row[] = [
  {
    key: 'register',
    answers: { ok: true },
    per: 'client',
    limit: { max: 2, window: 3600 },
    prepare: async (limits) => {
      const { browser } = testApp({ limits })

      return async n => browser().post('/register', { email: `user${n}@example.com`, password: PASSWORD })
    },
  },
  {
    key: 'signIn',
    answers: { ok: false, error: 'invalid' },
    per: 'client',
    limit: { max: 2, window: 900 },
    prepare: async (limits) => {
      const { browser } = testApp({ limits })

      return async n => browser().post('/password', { identifier: `user${n}@example.com`, password: PASSWORD })
    },
  },
  {
    key: 'signInAccount',
    answers: { ok: false, error: 'invalid' },
    per: 'account',
    prepare: async (limits) => {
      const { browser } = await registered(limits)

      return async () => browser().post('/password', { identifier: 'ada@example.com', password: WRONG })
    },
  },
  {
    key: 'reprove',
    answers: { ok: false, error: 'proof' },
    per: 'account',
    prepare: async (limits) => {
      const { ada } = await registered(limits)

      return async () => ada.call('changePassword', { password: WRONG }, 'a brand new password')
    },
  },
  {
    key: 'twoFactor',
    action: 'signing in',
    answers: { ok: false, error: 'invalid' },
    per: 'client',
    limit: { max: 2, window: 900 },
    prepare: async (limits) => {
      const { visitor } = await pendingSignIn(limits)

      return async () => visitor.call('verifyTwoFactor', '000000')
    },
  },
  {
    key: 'twoFactor',
    action: 'turning on',
    answers: { ok: false, error: 'invalid' },
    per: 'client',
    limit: { max: 2, window: 900 },
    prepare: async (limits) => {
      const { ada } = await secondFactor(limits)

      return async () => ada.call('enableTwoFactor', '000000')
    },
  },
  {
    key: 'twoFactorAccount',
    action: 'turning on',
    answers: { ok: false, error: 'invalid' },
    per: 'account',
    prepare: async (limits) => {
      const { ada, secret } = await secondFactor(limits)

      // The right code, once the guesses are spent, is refused too and turns nothing on.
      return async (n) => {
        const answer = await ada.call('enableTwoFactor', n > 8 ? await totpCode(secret, totpStep()) : '000000')

        expect(await ada.json('/me')).toMatchObject({ twoFactor: false })

        return answer
      }
    },
  },
  {
    key: 'twoFactorAccount',
    action: 'signing in',
    answers: { ok: false, error: 'invalid' },
    per: 'account',
    prepare: async (limits) => {
      const { visitor, secret } = await pendingSignIn(limits)

      // The right code, once the guesses are spent, is refused too and signs nobody in.
      return async (n) => {
        const answer = await visitor.call('verifyTwoFactor', n > 8 ? await totpCode(secret, totpStep()) : '000000')

        expect(await visitor.json('/me')).toBe('anonymous')

        return answer
      }
    },
  },
  {
    key: 'emailCode',
    answers: { ok: false, error: 'invalid' },
    per: 'client',
    limit: { max: 2, window: 900 },
    prepare: guessingCodes,
  },
  {
    key: 'emailCodeAccount',
    answers: { ok: false, error: 'invalid' },
    per: 'account',
    limit: { max: 2, window: 900 },
    prepare: guessingCodes,
  },
  {
    key: 'resend',
    answers: { ok: true },
    per: 'client',
    limit: { max: 2, window: 3600 },
    prepare: async (limits) => {
      const { ada } = await registered(limits, mail())

      return async () => ada.call('sendVerification')
    },
  },
  {
    key: 'emailChange',
    answers: { ok: true },
    per: 'client',
    limit: { max: 2, window: 3600 },
    prepare: async (limits) => {
      const { ada } = await registered(limits, mail())

      return async n => ada.call('changeEmail', { password: PASSWORD }, `new${n}@example.com`)
    },
  },
  {
    key: 'link',
    answers: { ok: false, error: 'invalid' },
    per: 'client',
    limit: { max: 2, window: 3600 },
    prepare: async (limits) => {
      const { browser } = await mailed(limits)

      return async () => browser().call('verifyEmail', 'not-a-token')
    },
  },
  {
    key: 'resendAccount',
    answers: { ok: true },
    per: 'account',
    prepare: async (limits) => {
      const { ada } = await registered(limits, mail())

      return async () => ada.call('sendVerification')
    },
  },
  {
    key: 'forgotAccount',
    answers: { ok: true },
    per: 'account',
    prepare: async (limits) => {
      const { browser } = await mailed(limits)

      return async () => browser().call('requestPasswordReset', 'ada@example.com')
    },
  },
  {
    key: 'forgot',
    answers: { ok: true },
    per: 'client',
    limit: { max: 2, window: 3600 },
    prepare: async (limits) => {
      const { browser } = await mailed(limits)

      return async n => browser().call('requestPasswordReset', `user${n}@example.com`)
    },
  },
  {
    key: 'magicLinkAccount',
    answers: { ok: true },
    per: 'account',
    prepare: async (limits) => {
      const { browser } = await mailed(limits)

      return async () => browser().call('requestMagicLink', 'ada@example.com')
    },
  },
  {
    key: 'magicLink',
    answers: { ok: true },
    per: 'client',
    limit: { max: 2, window: 3600 },
    prepare: async (limits) => {
      const { browser } = await mailed(limits)

      return async n => browser().call('requestMagicLink', `user${n}@example.com`)
    },
  },
  {
    key: 'emailChangeAccount',
    answers: { ok: true },
    per: 'account',
    prepare: async (limits) => {
      const { ada } = await registered(limits, mail())

      return async n => ada.call('changeEmail', { password: PASSWORD }, `new${n}@example.com`)
    },
  },
]

// Walked in the file of the feature they guard, where the rest of that feature's behaviour is.
const elsewhere: Partial<Record<keyof typeof DEFAULT_LIMITS, string>> = {
  export: 'pages.test.ts',
  signInAccountAll: 'signInLockout.test.ts',
  organization: 'organizations.test.ts',
  invite: 'organizations.test.ts',
  inviteAddress: 'organizations.test.ts',
  oauthRegister: 'oauthHardening.test.ts',
  oauthToken: 'oauthHardening.test.ts',
  oauthDocument: 'oauthHardening.test.ts',
}

describe('rate limits', () => {
  test('every limiter is walked here or in the file of its feature', () => {
    expect([...new Set([...rows.map(row => row.key), ...Object.keys(elsewhere)])].toSorted()).toEqual(Object.keys(DEFAULT_LIMITS).toSorted())
  })

  test.each(rows.map(row => [`${row.key}${row.action === undefined ? '' : ` (${row.action})`}`, row.per, row] as const))('%s answers `limited` once its attempts are spent, per %s', async (_name, _per, row) => {
    const key = row.key
    const limit = row.limit ?? DEFAULT_LIMITS[key]
    const attempt = await row.prepare({ [key]: limit })

    for (let n = 1; n <= limit.max; n++)
      expect(await attempt(n)).toMatchObject(row.answers)

    expect(await attempt(limit.max + 1)).toEqual({ ok: false, error: 'limited' })
  })
})
