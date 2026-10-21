import type { CredentialRules } from '../src/rules'
import { describe, expect, test } from 'bun:test'
import { passwordProblem, usernameProblem } from '../src/rules'
import { testApp } from './helpers/app'
import { mailbox } from './helpers/mail'

const RULES: CredentialRules = { password: { min: 12, max: 20, check: password => (/\d/).test(password) ? undefined : 'Add a digit.' }, username: { min: 3, max: 6 } }
const GOOD = 'twelve chars 1'

describe('credential rules', () => {
  test('the defaults hold without the option, and features() carries them', async () => {
    expect((await testApp().browser().call('features')).rules).toEqual({ password: { min: 10, max: 128 }, username: { min: 2, max: 32 } })
  })

  test('features() carries the app\'s limits, without the check', async () => {
    expect((await testApp({ rules: RULES }).browser().call('features')).rules).toEqual({ password: { min: 12, max: 20 }, username: { min: 3, max: 6 } })
  })

  test('register applies the length, the ceiling, the check and the username limits', async () => {
    const { browser } = testApp({ rules: RULES })
    const ada = browser()

    expect(await ada.call('register', { email: 'ada@example.com', password: 'only 11 ch1', username: 'ab' })).toMatchObject({ ok: false, errors: { password: 'too-short', username: 'length' } })
    expect(await ada.call('register', { email: 'ada@example.com', password: `${GOOD}${'x'.repeat(10)}`, username: 'abcdefg' })).toMatchObject({ ok: false, errors: { password: 'too-long', username: 'length' } })
    expect(await ada.call('register', { email: 'ada@example.com', password: 'twelve chars!', username: 'Ada' })).toMatchObject({ ok: false, errors: { password: 'Add a digit.' } })
    expect(await ada.call('register', { email: 'ada@example.com', password: GOOD, username: 'Ada' })).toMatchObject({ ok: true })
  })

  test('reset, change password, change username and createUser apply them', async () => {
    const { mailer, mails } = mailbox()
    const { auth, browser } = testApp({ rules: RULES, url: 'https://site.test', email: { mailer, links: { 'verify-email': '/v', 'reset-password': '/r', 'magic-link': '/m', 'change-email': '/c' }, requireVerified: false } })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: GOOD })
    await ada.call('requestPasswordReset', 'ada@example.com')

    const token = new URL(mails.findLast(mail => mail.kind === 'reset-password')!.url!).searchParams.get('token')!

    expect(await ada.call('resetPassword', token, 'twelve chars!')).toEqual({ ok: false, errors: { password: 'Add a digit.' } })
    expect(await ada.call('resetPassword', token, 'short1')).toEqual({ ok: false, errors: { password: 'too-short' } })
    expect(await ada.call('changePassword', { password: GOOD }, 'twelve chars!')).toEqual({ ok: false, errors: { password: 'Add a digit.' } })
    expect(await ada.call('changePassword', { password: GOOD }, 'twelve chars 2')).toEqual({ ok: true })
    expect(await ada.call('changeUsername', 'toolongname')).toEqual({ ok: false, errors: { username: 'length' } })
    expect(await ada.call('changeUsername', 'Ada')).toMatchObject({ ok: true })
    expect(await auth.createUser({ email: 'bob@example.com', username: 'Bob', password: 'nodigitsatall' })).toEqual({ ok: false, errors: { password: 'Add a digit.' } })
    expect(await auth.createUser({ email: 'bob@example.com', username: 'bo', password: GOOD })).toEqual({ ok: false, errors: { username: 'length' } })
    expect(await auth.createUser({ email: 'bob@example.com', username: 'Bob', password: GOOD })).toMatchObject({ ok: true })
  })

  test('a lower ceiling still lets an older, longer password sign in', async () => {
    const long = 'x'.repeat(40)
    const { browser, store, auth } = testApp({ rules: { password: { max: 64 } } })

    await auth.createUser({ email: 'ada@example.com', password: long })
    expect(await browser().post('/password', { identifier: 'ada@example.com', password: long })).toMatchObject({ ok: true })

    const tight = testApp({ store, rules: { password: { max: 20 } } })

    expect(await tight.browser().post('/password', { identifier: 'ada@example.com', password: long })).toMatchObject({ ok: true })
  })

  test('a range no value fits, or a bad limit, fails at boot naming it', () => {
    expect(() => testApp({ rules: { password: { min: 20, max: 10 } } })).toThrow('kay: rules.password.min is 20, over rules.password.max 10')
    expect(() => testApp({ rules: { username: { min: 0 } } })).toThrow('kay: rules.username.min is 0')
    expect(() => testApp({ rules: { password: { max: 1.5 } } })).toThrow('kay: rules.password.max is 1.5')
    expect(() => testApp({ rules: { password: { max: 5000 } } })).toThrow('kay: rules.password.max is 5000, over the 1024')
    expect(() => testApp({ rules: { username: { max: 500 } } })).toThrow('kay: rules.username.max is 500, over the 128')
  })

  test('the island-side functions take the same rules, or features().rules, and default to the built-in ones', async () => {
    expect(passwordProblem('x'.repeat(11))).toBeUndefined()
    expect(passwordProblem('x'.repeat(11), RULES)).toBe('too-short')
    expect(passwordProblem('twelve chars!', RULES)).toBe('Add a digit.')
    expect(passwordProblem(GOOD, (await testApp({ rules: RULES }).browser().call('features')).rules)).toBeUndefined()
    expect(usernameProblem('ab', RULES)).toBe('length')
    expect(usernameProblem('abcdefg', RULES)).toBe('length')
    expect(usernameProblem('abc', RULES)).toBeUndefined()
  })
})
