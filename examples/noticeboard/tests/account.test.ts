import { outbox } from '@kaynooo/kayjs-mail'
import { afterAll, beforeEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { auth } from '../src/auth'
import { signOut } from '../src/routes/account/index.kay'
import { mailLink, signIn } from '../src/routes/login.kay'
import { spend } from '../src/routes/magic.kay'
import { join } from '../src/routes/register.kay'
import { choose, request } from '../src/routes/reset.kay'
import { confirm } from '../src/routes/verify.kay'
import { joinAs, mailedToken } from './members'

const site = await testSite({ use: [auth.plugin] })

beforeEach(() => {
  outbox.clear()
})

afterAll(async () => {
  await site.close()
})

it('joins, signed in at once, and mails a link that confirms the address', async () => {
  const email = await joinAs(site, 'Ada')

  expect((await site.visit('/')).find('nav a')[1]?.text).toBe('Ada')
  expect((await site.visit('/account')).find('.kui-badge')[0]?.text).toBe('Not confirmed')

  const token = await mailedToken(site, email, '/verify')

  expect(outbox.to(email)[0]?.subject).toContain('Confirm')

  const confirmed = await site.submit(confirm, { token }, { from: '/verify' })

  expect(confirmed.url).toBe('/')
  expect((await site.visit('/account')).find('.kui-badge')[0]?.text).toBe('Confirmed')
})

it('words what kayjs-auth refuses a new member for', async () => {
  const page = await site.submit(join, { username: 'x', email: 'not an address', password: 'short' }, { from: '/register' })

  expect(page.status).toBe(400)
  expect(page.html).toContain('Write 2 to 32 characters')
  expect(page.html).toContain('Write an address such as ada@example.com')
  expect(page.html).toContain('Write at least 10 characters')
})

it('keeps the account section for members, and comes back to it after signing in', async () => {
  const visitor = await testSite({ use: [auth.plugin] })

  try {
    expect((await visitor.visit('/account')).url).toBe('/login?redirect=%2Faccount')
    expect((await visitor.submit(signIn, { identifier: 'nobody', password: 'wrong password!' }, { from: '/login' })).html).toContain('Wrong name, address or password')
  }
  finally {
    await visitor.close()
  }

  await joinAs(site, 'Grace')
  expect((await site.submit(signOut, {}, { from: '/account' })).url).toBe('/')
  expect((await site.visit('/account')).url).toBe('/login?redirect=%2Faccount')
  expect((await site.submit(signIn, { identifier: 'grace', password: 'correct horse battery', redirect: '/account' }, { from: '/login?redirect=%2Faccount' })).url).toBe('/account')
})

it('signs in from a mailed link, which only its button spends', async () => {
  const email = await joinAs(site, 'Linus')

  await site.submit(signOut, {}, { from: '/account' })
  outbox.clear()
  expect((await site.submit(mailLink, { email }, { from: '/login' })).html).toContain('a link to sign in is on its way')
  const token = await mailedToken(site, email, '/magic')

  expect((await site.visit(`/magic?token=${token}`)).find('nav a')[1]?.text).toBe('Sign in')
  expect((await site.submit(spend, { token }, { from: `/magic?token=${token}` })).find('nav a')[1]?.text).toBe('Linus')
  expect((await site.submit(spend, { token }, { from: `/magic?token=${token}` })).html).toContain('This link has expired or was already used.')
})

it('resets a forgotten password from a mailed link', async () => {
  const email = await joinAs(site, 'Barbara', { confirmed: true })

  await site.submit(signOut, {}, { from: '/account' })
  outbox.clear()
  await site.submit(request, { email }, { from: '/reset' })
  const token = await mailedToken(site, email, '/reset')

  expect((await site.submit(choose, { token, password: 'short' }, { from: `/reset?token=${token}` })).html).toContain('Write at least 10 characters')
  expect((await site.submit(choose, { token, password: 'a brand new passphrase' }, { from: `/reset?token=${token}` })).find('nav a')[1]?.text).toBe('Barbara')
  await site.submit(signOut, {}, { from: '/account' })
  expect((await site.submit(signIn, { identifier: email, password: 'a brand new passphrase' }, { from: '/login' })).url).toBe('/')
})
