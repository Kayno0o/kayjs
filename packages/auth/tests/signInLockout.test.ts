import type { LimitsOption } from '../src/limits'
import { describe, expect, test } from 'bun:test'
import { base32Encode } from '../src/totp'
import { sealTotpSecret } from '../src/twoFactor'
import { SECRET, testApp } from './helpers/app'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const WRONG = 'wrong password!'
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }

// An account whose address is verified, so the mail about it is sent, and a mailbox for it.
async function account(limits: LimitsOption, extra: Parameters<typeof testApp>[0] = {}) {
  const box = mailbox()
  const app = testApp({ rateLimit: limits, url: 'https://site.test', email: { mailer: box.mailer, links: LINKS, requireVerified: false }, ...extra })

  await app.browser().call('register', { email: 'ada@example.com', password: PASSWORD })

  const user = (await app.store.users.findByEmail('ada@example.com'))!

  await app.store.users.update(user.id, { emailVerifiedAt: new Date() })

  // Registering mails a verification link; what is left is only what the guessing causes.
  const notices = () => box.mails.filter(mail => mail.kind === 'sign-in-locked')

  return { ...app, user, box, notices }
}

async function attempt(app: Awaited<ReturnType<typeof account>>, from: string, password: string, identifier = 'ada@example.com') {
  return app.browser().json('/password', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': from }, body: JSON.stringify({ identifier, password }) })
}

describe('guessing at an account', () => {
  test('the attempts table holds a digest of the client, never its address', async () => {
    const app = await account({})
    const keys: string[] = []
    const hit = app.store.attempts.hit.bind(app.store.attempts)

    app.store.attempts.hit = async (key, window) => {
      keys.push(key)

      return hit(key, window)
    }
    await attempt(app, '10.0.0.77', WRONG)

    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter(key => key.includes('10.0.0.77'))).toEqual([])
  })

  test('a client that keeps failing is stopped alone, and the right password from another still signs in', async () => {
    const app = await account({ signInAccount: { max: 3, window: '900s' } })

    for (let i = 0; i < 3; i++)
      expect(await attempt(app, '10.0.0.1', WRONG)).toEqual({ ok: false, error: 'invalid' })

    expect(await attempt(app, '10.0.0.1', WRONG)).toEqual({ ok: false, error: 'limited' })
    expect(await attempt(app, '10.0.0.2', PASSWORD)).toMatchObject({ ok: true })
  })

  test('the attacker behind the same address as the user stops them too, as one client key', async () => {
    const app = await account({ signInAccount: { max: 2, window: '900s' } })

    await attempt(app, '10.0.0.1', WRONG)
    await attempt(app, '10.0.0.1', WRONG)

    expect(await attempt(app, '10.0.0.1', PASSWORD)).toEqual({ ok: false, error: 'limited' })
  })

  test('a successful sign-in spends nothing and clears the client\'s failures', async () => {
    const app = await account({ signInAccount: { max: 2, window: '900s' } })

    for (let i = 0; i < 6; i++)
      expect(await attempt(app, '10.0.0.1', PASSWORD)).toMatchObject({ ok: true })

    await attempt(app, '10.0.0.1', WRONG)
    expect(await attempt(app, '10.0.0.1', PASSWORD)).toMatchObject({ ok: true })
    await attempt(app, '10.0.0.1', WRONG)
    expect(await attempt(app, '10.0.0.1', WRONG)).toEqual({ ok: false, error: 'invalid' })
  })

  test('every spelling of the email counts as one account, per client', async () => {
    const app = await account({ signInAccount: { max: 2, window: '900s' } })

    await attempt(app, '10.0.0.1', WRONG, 'ada@example.com')
    await attempt(app, '10.0.0.1', WRONG, ' ADA@Example.com ')

    expect(await attempt(app, '10.0.0.1', WRONG, 'Ada@example.COM')).toEqual({ ok: false, error: 'limited' })
  })

  test('an email with no account runs out per client the same way, and mails no one', async () => {
    const app = await account({ signInAccount: { max: 2, window: '900s' }, signInAccountAll: { max: 3, window: '900s' } })

    await attempt(app, '10.0.0.1', WRONG, 'nobody@example.com')
    await attempt(app, '10.0.0.1', WRONG, 'Nobody@example.com')

    expect(await attempt(app, '10.0.0.1', WRONG, ' nobody@example.com')).toEqual({ ok: false, error: 'limited' })

    for (const from of ['10.0.0.2', '10.0.0.3'])
      await attempt(app, from, WRONG, 'nobody@example.com')

    expect(await attempt(app, '10.0.0.4', WRONG, 'nobody@example.com')).toEqual({ ok: false, error: 'limited' })
    expect(app.box.mails.map(mail => mail.to)).not.toContain('nobody@example.com')
    expect(app.notices()).toHaveLength(0)
  })

  test('failures from many addresses reach a looser ceiling, which mails the holder once', async () => {
    const app = await account({ signInAccount: { max: 2, window: '900s' }, signInAccountAll: { max: 5, window: '900s' } })

    for (let i = 1; i <= 5; i++)
      expect(await attempt(app, `10.0.1.${i}`, WRONG)).toEqual({ ok: false, error: 'invalid' })

    expect(app.notices()).toHaveLength(0)

    for (let i = 6; i <= 9; i++)
      expect(await attempt(app, `10.0.1.${i}`, WRONG)).toEqual({ ok: false, error: 'limited' })

    const [notice] = await app.box.take({ kind: 'sign-in-locked', to: 'ada@example.com' })

    expect(notice).toMatchObject({ to: 'ada@example.com', kind: 'sign-in-locked' })
    expect(app.notices()).toHaveLength(1)
    expect(await attempt(app, '10.0.2.1', PASSWORD)).toEqual({ ok: false, error: 'limited' })
    expect(app.notices()).toHaveLength(1)
  })

  test('only failures raise the ceiling: signing in over and over never reaches it', async () => {
    const app = await account({ signInAccountAll: { max: 3, window: '900s' } })

    for (let i = 1; i <= 10; i++)
      expect(await attempt(app, `10.0.3.${i}`, PASSWORD)).toMatchObject({ ok: true })

    expect(app.notices()).toHaveLength(0)
  })

  test('the holder signing in gives an attacker no fresh ceiling', async () => {
    const app = await account({ signInAccount: { max: 10, window: '900s' }, signInAccountAll: { max: 4, window: '900s' } })

    await attempt(app, '10.0.5.1', WRONG)
    await attempt(app, '10.0.5.2', WRONG)
    await attempt(app, '10.0.5.3', WRONG)
    expect(await attempt(app, '10.0.5.9', PASSWORD)).toMatchObject({ ok: true })

    expect(await attempt(app, '10.0.5.4', WRONG)).toEqual({ ok: false, error: 'invalid' })
    expect(await attempt(app, '10.0.5.5', WRONG)).toEqual({ ok: false, error: 'limited' })
    expect(await attempt(app, '10.0.5.9', PASSWORD)).toEqual({ ok: false, error: 'limited' })
  })

  test('the lockout mail goes out once a day however often the ceiling is reached again', async () => {
    const app = await account({ signInAccount: { max: 10, window: '900s' }, signInAccountAll: { max: 2, window: '900s' } })

    for (let window = 0; window < 3; window++) {
      for (let i = 1; i <= 4; i++)
        await attempt(app, `10.0.6.${i}`, WRONG)

      // The ceiling's window ends.
      for (const key of ['sign-in-failures', 'sign-in-ceiling'])
        await app.store.attempts.reset(`${key}:id:${app.user.id}`)
    }

    expect(app.notices()).toHaveLength(1)

    await app.store.attempts.reset(`sign-in-locked-mail:${app.user.id}`)

    for (let i = 1; i <= 4; i++)
      await attempt(app, `10.0.6.${i}`, WRONG)

    expect(app.notices()).toHaveLength(2)
  })

  test('a burst of parallel guesses from many addresses cannot pass the ceiling', async () => {
    const app = await account({ signInAccount: { max: 2, window: '900s' }, signInAccountAll: { max: 4, window: '900s' } })
    const answers = await Promise.all(Array.from({ length: 12 }, async (_, i) => attempt(app, `10.0.4.${i + 1}`, WRONG)))

    expect(answers.filter(answer => (answer as { error?: string }).error === 'invalid')).toHaveLength(4)
  })

  test('a second factor stays asked for: the right password from another client still reaches it during an attack', async () => {
    const app = await account({ signInAccount: { max: 2, window: '900s' } })
    const secret = base32Encode(new TextEncoder().encode('a-plain-legacy-secret'))

    await app.store.users.update(app.user.id, { totpSecret: sealTotpSecret(SECRET, app.user.id, secret), totpEnabledAt: new Date() })

    for (let i = 0; i < 3; i++)
      await attempt(app, '10.0.0.1', WRONG)

    const answer = await attempt(app, '10.0.0.2', PASSWORD)

    expect(answer).toMatchObject({ ok: true })
    expect(answer).toMatchObject({ ok: true, redirect: expect.stringContaining('two-factor') })
  })

  test('confirming an address with the password counts as the same client\'s guess', async () => {
    const app = await account({ signInAccount: { max: 2, window: '900s' } })
    const token = new URL(app.box.mails.find(mail => mail.kind === 'verify-email')!.url!).searchParams.get('token')!

    await app.store.users.update(app.user.id, { emailVerifiedAt: null })

    const verify = async (from: string, password: string) => app.browser().json('/call/verifyEmail', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': from }, body: JSON.stringify([token, password]) })

    expect(await verify('10.0.0.1', WRONG)).toMatchObject({ ok: false })
    await attempt(app, '10.0.0.1', WRONG)

    expect(await attempt(app, '10.0.0.1', PASSWORD)).toEqual({ ok: false, error: 'limited' })
    expect(await verify('10.0.0.1', PASSWORD)).toEqual({ ok: false, error: 'limited' })
    expect(await verify('10.0.0.2', PASSWORD)).toMatchObject({ ok: true })
  })
})
