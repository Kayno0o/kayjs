import type { AuthEvent } from '../src/events'
import type { Mail } from '../src/mail'
import { describe, expect, test } from 'bun:test'
import { totpCode, totpStep } from '../src/totp'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const LINKS = { 'verify-email': '/v', 'reset-password': '/r', 'magic-link': '/m', 'change-email': '/c' }

// A verified user, and every mail and event from then on.
async function verified() {
  const mails: Mail[] = []
  const events: { event: AuthEvent, detail: string | undefined }[] = []
  const app = testApp({
    url: 'https://site.test',
    site: 'Site',
    email: { mailer: { send: mail => void mails.push(mail) }, links: LINKS },
    onEvent: (event, _user, detail) => {
      events.push({ event, detail })
    },
  })
  const ada = app.browser()

  await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
  await ada.call('verifyEmail', new URL(mails.at(-1)!.url!).searchParams.get('token'))
  mails.length = 0

  const notices = () => mails.filter(mail => mail.url === undefined).map(mail => mail.kind)

  return { ...app, ada, mails, events, notices }
}

function from(address: string, agent: string) {
  return { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': address, 'user-agent': agent }, body: JSON.stringify({ identifier: 'ada@example.com', password: PASSWORD }) }
}

describe('new sign-ins', () => {
  test('a sign-in from another device or network mails the user, one from a known one does not', async () => {
    const { browser, mails, notices } = await verified()

    await browser().json('/password', from('10.0.0.1', 'Firefox'))
    await browser().json('/password', from('10.0.0.1', 'Firefox'))

    // Registering signed in from the test's own address: this one is new, the second is known.
    expect(notices()).toEqual(['new-sign-in'])

    await browser().json('/password', from('10.0.0.2', 'Firefox'))

    expect(notices()).toEqual(['new-sign-in', 'new-sign-in'])
    expect(mails.at(-1)).toMatchObject({ to: 'ada@example.com', subject: 'New sign-in on Site' })
  })
})

describe('changes to what protects the account', () => {
  test('changing the password', async () => {
    const { ada, notices, events } = await verified()

    await ada.call('changePassword', { password: PASSWORD }, 'a brand new password')

    expect(notices()).toEqual(['password-changed'])
    expect(events.map(entry => entry.event)).toContain('password-changed')
  })

  test('moving to another address warns the old one', async () => {
    const { ada, mails } = await verified()

    await ada.call('changeEmail', { password: PASSWORD }, 'ada@new.test')
    await ada.call('confirmEmailChange', new URL(mails.at(-1)!.url!).searchParams.get('token'))

    expect(mails.at(-1)).toMatchObject({ to: 'ada@example.com', kind: 'email-changed', site: 'Site', detail: 'ada@new.test' })
    expect(mails.at(-1)!.text).toContain('ada@new.test')
  })

  test('the second factor going on and off, and a recovery code spent', async () => {
    const { ada, browser, notices } = await verified()
    const { setup } = await ada.call('setUpTwoFactor', { password: PASSWORD })
    const { recoveryCodes } = await ada.call('enableTwoFactor', await totpCode(setup.secret, totpStep()))
    const visitor = browser()

    await visitor.post('/password', { identifier: 'ada@example.com', password: PASSWORD })
    await visitor.call('verifyTwoFactor', recoveryCodes[0])
    const { recoveryCodes: fresh } = await ada.call('regenerateRecoveryCodes', { code: recoveryCodes[1] })

    await ada.call('disableTwoFactor', { code: fresh[0] })

    expect(notices()).toEqual(['two-factor-enabled', 'recovery-code-used', 'recovery-code-used', 'recovery-codes-regenerated', 'recovery-code-used', 'two-factor-disabled'])
  })

  test('a token minted, and the account deleted', async () => {
    const { ada, notices, events } = await verified()

    await ada.call('createToken', { password: PASSWORD }, 'Phone')
    await ada.call('deleteAccount', { password: PASSWORD })

    expect(notices()).toEqual(['token-created', 'account-deleted'])
    expect(events.find(entry => entry.event === 'token-created')?.detail).toBe('Phone')
  })

  test('an unverified address is never mailed a notice, though the app still hears of it', async () => {
    const mails: Mail[] = []
    const events: AuthEvent[] = []
    const { browser } = testApp({ url: 'https://site.test', email: { mailer: { send: mail => void mails.push(mail) }, links: LINKS }, onEvent: event => void events.push(event) })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.call('changePassword', { password: PASSWORD }, 'a brand new password')

    expect(mails.map(mail => mail.kind)).toEqual(['verify-email'])
    expect(events).toEqual(['signed-in', 'password-changed'])
  })
})
