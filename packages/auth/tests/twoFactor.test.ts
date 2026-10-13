import type { Mail } from '../src/mail'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { base32Decode, base32Encode, otpauthUri, totpCode, totpStep, verifyTotp } from '../src/totp'
import { sealTotpSecret } from '../src/twoFactor'
import { SECRET, testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'

afterEach(() => {
  setSystemTime()
})

describe('totp', () => {
  test('matches the RFC 6238 test vector', async () => {
    // RFC 6238 appendix B: the ASCII secret 12345678901234567890 at 59 seconds gives 94287082, of which six digits are kept.
    const secret = base32Encode(new TextEncoder().encode('12345678901234567890'))

    expect(await totpCode(secret, totpStep(59_000))).toBe('287082')
    expect(base32Decode(secret)).toEqual(new TextEncoder().encode('12345678901234567890'))
  })

  test('accepts a code one step either side, and nothing further', async () => {
    const secret = base32Encode(new Uint8Array(20).fill(7))
    const now = 1_000_000_000_000
    const step = totpStep(now)

    expect(await verifyTotp(secret, await totpCode(secret, step - 1), now)).toBe(step - 1)
    expect(await verifyTotp(secret, (await totpCode(secret, step + 1)).replace(/(\d{3})/, '$1 '), now)).toBe(step + 1)
    expect(await verifyTotp(secret, await totpCode(secret, step + 2), now)).toBeUndefined()
  })

  test('writes the URI an authenticator scans', () => {
    expect(otpauthUri({ secret: 'ABC', account: 'ada@example.com', issuer: 'Site' })).toBe('otpauth://totp/Site%3Aada%40example.com?secret=ABC&issuer=Site&algorithm=SHA1&digits=6&period=30')
  })
})

async function enrolled() {
  const app = testApp({ site: 'Site' })
  const ada = app.browser()

  await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
  const setup = await ada.call('setUpTwoFactor', { password: PASSWORD })
  const secret = setup.setup.secret as string
  const code = async (offset = 0) => totpCode(secret, totpStep() + offset)
  const enabled = await ada.call('enableTwoFactor', await code())

  return { ...app, ada, setup, secret, code, recoveryCodes: enabled.recoveryCodes as string[] }
}

describe('changes to the second factor', () => {
  test('turning it on, new recovery codes and turning it off each end the user\'s other sessions and bearer tokens, this one kept', async () => {
    const app = testApp({ site: 'Site' })
    const ada = app.browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    const { id } = await ada.json('/me') as { id: string }
    // Another browser and a device token, for the change that follows to end.
    const otherWaysIn = async () => {
      const elsewhere = app.browser()

      await elsewhere.fetch(`/sign-in/${id}`, { method: 'POST' })
      const minted = await ada.call('createToken', { password: PASSWORD }, 'phone')

      expect(await elsewhere.json('/me')).toMatchObject({ id })

      return async () => {
        expect(await ada.json('/me')).toMatchObject({ id })
        expect(await elsewhere.json('/me')).toBe('anonymous')
        expect(await app.browser().json('/me', { headers: { authorization: `Bearer ${minted.token}` } })).toBe('anonymous')
      }
    }

    const setup = await ada.call('setUpTwoFactor', { password: PASSWORD })
    const secret = setup.setup.secret as string
    let ended = await otherWaysIn()

    expect(await ada.call('enableTwoFactor', await totpCode(secret, totpStep()))).toMatchObject({ ok: true })
    await ended()

    ended = await otherWaysIn()
    const regenerated = await ada.call('regenerateRecoveryCodes', { code: await totpCode(secret, totpStep() + 1) })

    expect(regenerated).toMatchObject({ ok: true })
    await ended()

    ended = await otherWaysIn()
    expect(await ada.call('disableTwoFactor', { code: regenerated.recoveryCodes[0] })).toEqual({ ok: true })
    await ended()
  })
})

describe('setting up a second factor', () => {
  test('gives a secret, its URI and a QR code, and turns on with a code from it', async () => {
    const { setup, recoveryCodes, ada, store } = await enrolled()

    expect(setup.setup.uri).toStartWith('otpauth://totp/Site%3Aada%40example.com?secret=')
    expect(setup.setup.qr).toStartWith('data:image/svg+xml,')
    expect(recoveryCodes).toHaveLength(10)
    expect(recoveryCodes[0]).toMatch(/^[2-9a-z]{5}-[2-9a-z]{5}-[2-9a-z]{5}$/)
    expect(await ada.json('/me')).toMatchObject({ twoFactor: true })
    expect(await ada.call('recoveryCodesLeft')).toBe(10)
    expect((await store.users.findByEmail('ada@example.com'))?.totpSecret).not.toContain(setup.setup.secret)
  })

  test('needs the password to start, and a right code to turn on', async () => {
    const { browser } = testApp()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('setUpTwoFactor', { password: 'wrong password!' })).toEqual({ ok: false, error: 'proof' })
    expect(await ada.call('enableTwoFactor', '123456')).toEqual({ ok: false, error: 'not-set-up' })

    await ada.call('setUpTwoFactor', { password: PASSWORD })

    expect(await ada.call('enableTwoFactor', '000000')).toEqual({ ok: false, error: 'invalid' })
    expect(await ada.json('/me')).toMatchObject({ twoFactor: false })
  })

  test('turning on takes no more guesses than a sign-in code does, so a session alone cannot search the pending secret', async () => {
    const { browser } = testApp()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    const setup = await ada.call('setUpTwoFactor', { password: PASSWORD })

    for (let attempt = 0; attempt < 8; attempt++)
      await ada.call('enableTwoFactor', '000000')

    expect(await ada.call('enableTwoFactor', await totpCode(setup.setup.secret, totpStep()))).toEqual({ ok: false, error: 'limited' })
    expect(await ada.json('/me')).toMatchObject({ twoFactor: false })
  })
})

describe('signing in with a second factor', () => {
  test('a right password parks the sign-in until the code', async () => {
    const { browser, code } = await enrolled()
    const visitor = browser()

    expect(await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD, redirect: '/account' })).toEqual({ ok: true, redirect: '/two-factor' })
    expect(await visitor.json('/me')).toBe('anonymous')
    expect(await visitor.call('twoFactorPending')).toBe(true)

    expect(await visitor.call('verifyTwoFactor', await code(1))).toEqual({ ok: true, redirect: '/account' })
    expect(await visitor.json('/me')).toMatchObject({ email: 'ada@example.com' })
    expect(await visitor.call('twoFactorPending')).toBe(false)
  })

  test('a code works once, even at another sign-in', async () => {
    const { browser, code } = await enrolled()
    const first = browser()
    const second = browser()
    const used = await code(1)

    await first.post('/password', { identifier: 'ada@example.com', password: PASSWORD })
    await second.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    expect(await first.call('verifyTwoFactor', used)).toMatchObject({ ok: true })
    expect(await second.call('verifyTwoFactor', used)).toEqual({ ok: false, error: 'invalid' })
  })

  test('a recovery code works in place of the code, once', async () => {
    const { browser, recoveryCodes } = await enrolled()
    const visitor = browser()

    await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    expect(await visitor.call('verifyTwoFactor', recoveryCodes[0]!.toUpperCase())).toMatchObject({ ok: true })
    expect(await visitor.call('recoveryCodesLeft')).toBe(9)

    const again = browser()

    await again.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    expect(await again.call('verifyTwoFactor', recoveryCodes[0])).toEqual({ ok: false, error: 'invalid' })
  })

  test('without a parked sign-in, or after ten minutes, there is nothing to finish', async () => {
    const { browser, code } = await enrolled()
    const visitor = browser()

    expect(await visitor.call('verifyTwoFactor', await code())).toEqual({ ok: false, error: 'expired' })

    await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })
    setSystemTime(Date.now() + 11 * 60 * 1000)

    expect(await visitor.call('verifyTwoFactor', await code())).toEqual({ ok: false, error: 'expired' })
  })

  test('stops an account after eight wrong codes', async () => {
    const { browser, code } = await enrolled()
    const visitor = browser()

    await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    for (let attempt = 0; attempt < 8; attempt++)
      expect(await visitor.call('verifyTwoFactor', '000000')).toEqual({ ok: false, error: 'invalid' })

    expect(await visitor.call('verifyTwoFactor', await code())).toEqual({ ok: false, error: 'limited' })
  })

  test('a magic link sign-in asks for the code too', async () => {
    const mails: Mail[] = []
    const { browser } = testApp({ url: 'https://site.test', email: { mailer: { send: mail => void mails.push(mail) }, links: { 'verify-email': '/v', 'reset-password': '/r', 'magic-link': '/m', 'change-email': '/c' }, requireVerified: false } })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    // Verified first: a magic link that proves an address for the first time hands the account over clean, its second factor dropped.
    await ada.call('verifyEmail', new URL(mails.findLast(mail => mail.kind === 'verify-email')!.url!).searchParams.get('token'))
    const { setup } = await ada.call('setUpTwoFactor', { password: PASSWORD })

    await ada.call('enableTwoFactor', await totpCode(setup.secret, totpStep()))

    const visitor = browser()

    await visitor.call('requestMagicLink', 'ada@example.com', '/account')
    const token = new URL(mails.at(-1)!.url!).searchParams.get('token')

    expect(await visitor.call('signInWithMagicLink', token)).toEqual({ ok: true, redirect: '/two-factor' })
    expect(await visitor.json('/me')).toBe('anonymous')
    expect(await visitor.call('verifyTwoFactor', await totpCode(setup.secret, totpStep() + 1))).toEqual({ ok: true, redirect: '/account' })
  })
})

describe('a secret kept plain before kayjs-auth', () => {
  test('signs in once the store hands it over sealed', async () => {
    const { browser, store } = testApp()
    const secret = base32Encode(new TextEncoder().encode('a-plain-legacy-secret'))
    const { user } = await browser().call('register', { email: 'ada@example.com', password: PASSWORD })

    await store.users.update(user.id, { totpSecret: sealTotpSecret(SECRET, user.id, secret), totpEnabledAt: new Date() })
    const visitor = browser()

    expect(await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })).toMatchObject({ redirect: '/two-factor' })
    expect(await visitor.call('verifyTwoFactor', await totpCode(secret, totpStep()))).toMatchObject({ ok: true })
    expect(await visitor.json('/me')).toMatchObject({ id: user.id, twoFactor: true })
  })

  test('opens under a rotated secret list, sealed with the old secret or the new', async () => {
    const OLD = 'an-older-secret-that-is-long-enough-for-kayjs-auth'
    const { browser, store } = testApp({ secret: [SECRET, OLD] })
    const secret = base32Encode(new TextEncoder().encode('a-plain-legacy-secret'))

    for (const [email, sealWith] of [['ada@example.com', [OLD]], ['bob@example.com', [SECRET, OLD]]] as const) {
      const { user } = await browser().call('register', { email, password: PASSWORD })

      await store.users.update(user.id, { totpSecret: sealTotpSecret([...sealWith], user.id, secret), totpEnabledAt: new Date() })
      const visitor = browser()

      await visitor.post('/password', { identifier: email, password: PASSWORD })

      expect(await visitor.call('verifyTwoFactor', await totpCode(secret, totpStep()))).toMatchObject({ ok: true })
    }
  })

  test('is sealed for its own user only', async () => {
    const { browser, store } = testApp()
    const secret = base32Encode(new TextEncoder().encode('a-plain-legacy-secret'))
    const { user } = await browser().call('register', { email: 'ada@example.com', password: PASSWORD })

    await store.users.update(user.id, { totpSecret: sealTotpSecret(SECRET, 'someone-else', secret), totpEnabledAt: new Date() })
    const visitor = browser()

    await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    expect(await visitor.call('verifyTwoFactor', await totpCode(secret, totpStep()))).toMatchObject({ ok: false })
  })
})

describe('turning the second factor off', () => {
  test('needs a code even from an account with a password, and voids the recovery codes', async () => {
    const { ada, recoveryCodes } = await enrolled()

    expect(await ada.call('disableTwoFactor', {})).toEqual({ ok: false, error: 'proof' })
    expect(await ada.call('disableTwoFactor', { password: PASSWORD })).toEqual({ ok: false, error: 'proof' })
    expect(await ada.call('regenerateRecoveryCodes', { password: PASSWORD })).toEqual({ ok: false, error: 'proof' })
    expect(await ada.call('disableTwoFactor', { code: recoveryCodes[0] })).toEqual({ ok: true })
    expect(await ada.json('/me')).toMatchObject({ twoFactor: false })
    expect(await ada.call('recoveryCodesLeft')).toBe(0)
  })

  test('regenerating the codes voids the old set', async () => {
    const { ada, browser, recoveryCodes } = await enrolled()
    const fresh = await ada.call('regenerateRecoveryCodes', { code: recoveryCodes[9] })
    const visitor = browser()

    expect(fresh.recoveryCodes).toHaveLength(10)

    await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })

    expect(await visitor.call('verifyTwoFactor', recoveryCodes[0])).toEqual({ ok: false, error: 'invalid' })
    expect(await visitor.call('verifyTwoFactor', fresh.recoveryCodes[0])).toMatchObject({ ok: true })
  })
})
