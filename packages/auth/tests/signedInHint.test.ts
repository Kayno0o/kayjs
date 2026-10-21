import { describe, expect, test } from 'bun:test'
import { totpCode, totpStep } from '../src/totp'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const HINT = /(?:^|\n)kay_user=([\w-]+); /

// The Set-Cookie lines of a response, as one text.
const cookiesOf = (response: Response): string => response.headers.getSetCookie().join('\n')

async function user(app: { auth: { createUser: (input: { email: string, password: string, emailVerified: boolean }) => Promise<{ ok: true, user: { id: string } } | { ok: false, errors: unknown }> } }, email = 'ada@example.com') {
  const made = await app.auth.createUser({ email, password: PASSWORD, emailVerified: true })

  if (!made.ok)
    throw new Error('no user')

  return made.user
}

describe('the cookie marking a browser as signed in', () => {
  test('is set by a sign-in with a value of its own each time, readable, for the whole site, and cleared by a sign-out', async () => {
    const app = testApp()
    const ada = await user(app)
    const browser = app.browser()
    const first = cookiesOf(await browser.fetch(`/sign-in/${ada.id}`, { method: 'POST' }))

    expect(first).toMatch(HINT)

    const line = first.split('\n').find(cookie => cookie.startsWith('kay_user='))!

    expect(line).toContain('Path=/')
    expect(line).toContain('SameSite=Lax')
    expect(line).not.toContain('HttpOnly')
    expect(line).not.toContain('Secure')
    expect(browser.cookieHeader()).toContain('kay_user=')

    const out = cookiesOf(await browser.fetch('/sign-out', { method: 'POST' }))

    expect(out).toMatch(/kay_user=; .*Max-Age=0/)
    expect(browser.cookieHeader()).not.toContain('kay_user=')

    const second = cookiesOf(await browser.fetch(`/sign-in/${ada.id}`, { method: 'POST' }))

    expect(HINT.exec(second)![1]).not.toBe(HINT.exec(first)![1])
  })

  test('is set by a password sign-in, which answers a Response of the route\'s own, and by registering', async () => {
    const app = testApp()
    const ada = await user(app)
    const browser = app.browser()

    expect(cookiesOf(await browser.fetch('/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'ada@example.com', password: PASSWORD }) }))).toMatch(HINT)
    expect(ada.id).toBeString()
    expect(cookiesOf(await app.browser().fetch('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'grace@example.com', password: PASSWORD }) }))).toMatch(HINT)
  })

  test('is Secure over https, as the proxy says too', async () => {
    const app = testApp()
    const ada = await user(app)
    const direct = await app.app.handle(new Request(`https://site.test/sign-in/${ada.id}`, { method: 'POST' }))
    const proxied = await app.app.handle(new Request(`http://site.test/sign-in/${ada.id}`, { method: 'POST', headers: { 'x-forwarded-proto': 'https' } }))

    expect(cookiesOf(direct)).toMatch(/kay_user=[\w-]+; .*Secure/)
    expect(cookiesOf(proxied)).toMatch(/kay_user=[\w-]+; .*Secure/)
  })

  test('is not set for a guest, nor cleared by a sign-out nobody carried one to', async () => {
    const app = testApp()
    const guest = app.browser()
    const response = await guest.fetch('/call/signInAsGuest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' })

    expect(cookiesOf(response)).not.toContain('kay_user')
    expect(cookiesOf(await guest.fetch('/sign-out', { method: 'POST' }))).not.toContain('kay_user')
  })

  test('waits for the second factor: a password alone sets nothing, the code does', async () => {
    const app = testApp({ site: 'Site' })
    const ada = await user(app)
    const owner = app.browser()

    await owner.fetch(`/sign-in/${ada.id}`, { method: 'POST' })

    const set = await owner.callOk('setUpTwoFactor', { password: PASSWORD })

    await owner.callOk('enableTwoFactor', await totpCode(set.setup.secret, totpStep()))

    const phone = app.browser()
    const password = await phone.fetch('/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'ada@example.com', password: PASSWORD }) })

    expect(cookiesOf(password)).not.toContain('kay_user')
    expect(cookiesOf(await phone.fetch('/call/verifyTwoFactor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([await totpCode(set.setup.secret, totpStep() + 1)]) }))).toMatch(HINT)
  })

  test('is cleared when the session turns out to have ended elsewhere', async () => {
    const app = testApp()
    const ada = await user(app)
    const laptop = app.browser()
    const phone = app.browser()

    await laptop.fetch(`/sign-in/${ada.id}`, { method: 'POST' })
    await phone.fetch(`/sign-in/${ada.id}`, { method: 'POST' })
    await phone.fetch('/sign-out-everywhere', { method: 'POST' })

    expect(cookiesOf(await laptop.fetch('/me'))).toMatch(/kay_user=; .*Max-Age=0/)
  })

  test('is not added to a response that signs no one in or out', async () => {
    const app = testApp()
    const ada = await user(app)
    const browser = app.browser()

    await browser.fetch(`/sign-in/${ada.id}`, { method: 'POST' })
    expect(cookiesOf(await browser.fetch('/me'))).not.toContain('kay_user')
  })
})
