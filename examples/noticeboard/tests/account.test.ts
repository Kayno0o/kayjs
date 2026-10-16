import { outbox } from '@kaynooo/kayjs-mail'
import { afterAll, beforeEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { joinAs, mailedToken } from './members'
import { magicLink, password, register, request, reset, signOut, spend, verify } from './pages'

const site = await testSite()

beforeEach(() => {
  outbox.clear()
})

afterAll(async () => {
  await site.close()
})

it('joins, signed in at once, and mails a link that confirms the address', async () => {
  const email = await joinAs(site, 'Ada')

  expect((await site.visit('/')).find('nav a')[1]?.text).toBe('Ada')
  expect((await site.visit('/auth/account')).html).toContain('Not verified')

  const token = await mailedToken(site, email, '/auth/verify-email')

  expect(outbox.to(email)[0]?.subject).toContain('Confirm')

  const confirmed = await site.submit(verify, { token }, { from: '/auth/verify-email' })

  expect(confirmed.url).toBe('/')
  expect((await site.visit('/auth/account')).html).toContain('Verified')
})

it('words what kayjs-auth refuses a new member for', async () => {
  await signOut(site)

  const page = await site.submit(register, { email: 'not an address', password: 'short' }, { from: await site.visit('/auth/register') })

  expect(page.status).toBe(400)
  expect(page.find('.kui-form-field-issue').map(issue => issue.text)).toEqual(['Type a valid address.', 'Use at least 10 characters.'])
})

it('keeps the account section for members, and comes back to it after signing in', async () => {
  await joinAs(site, 'Grace')
  await signOut(site)
  expect((await site.visit('/auth/account')).url).toBe('/auth/sign-in?redirect=%2Fauth%2Faccount')
  expect((await site.submit(password, { identifier: 'nobody', password: 'wrong password!' }, { from: await site.visit('/auth/sign-in') })).status).toBe(400)
  expect((await site.submit(password, { identifier: 'grace', password: 'correct horse battery', redirect: '/auth/account' }, { from: await site.visit('/auth/sign-in?redirect=%2Fauth%2Faccount') })).url).toBe('/auth/account')
})

it('signs in from a mailed link, which only its button spends', async () => {
  const email = await joinAs(site, 'Linus')

  await signOut(site)
  outbox.clear()
  await site.submit(magicLink, { email }, { from: await site.visit('/auth/sign-in') })
  const token = await mailedToken(site, email, '/auth/magic-link')

  expect((await site.visit(`/auth/magic-link?token=${token}`)).find('nav a')[1]?.text).toBe('Sign in')
  expect((await site.submit(spend, { token }, { from: `/auth/magic-link?token=${token}` })).find('nav a')[1]?.text).toBe('Linus')

  await signOut(site)
  expect((await site.submit(spend, { token }, { from: `/auth/magic-link?token=${token}` })).status).toBe(400)
})

it('resets a forgotten password from a mailed link', async () => {
  const email = await joinAs(site, 'Barbara', { confirmed: true })

  await signOut(site)
  outbox.clear()
  await site.submit(request, { email }, { from: await site.visit('/auth/reset-password') })
  const token = await mailedToken(site, email, '/auth/reset-password')

  expect((await site.submit(reset, { token, password: 'short' }, { from: `/auth/reset-password?token=${token}` })).status).toBe(400)
  expect((await site.submit(reset, { token, password: 'a brand new passphrase' }, { from: `/auth/reset-password?token=${token}` })).find('nav a')[1]?.text).toBe('Barbara')
  await signOut(site)
  expect((await site.submit(password, { identifier: email, password: 'a brand new passphrase' }, { from: await site.visit('/auth/sign-in') })).url).toBe('/')
})
