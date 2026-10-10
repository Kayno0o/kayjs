import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { totpCode, totpStep } from '../../../src/totp'
import { auth, mails } from '../src/auth'

// The fixture is served the way an app serves itself: kayjs-auth's plugin, then kay's pages.
const ROOT = join(import.meta.dir, '..')
// kay check prints this line on success since kay 1.18, nothing before.
const CLEAN = /^(?:checked with no problems in \d+ ms\n)?$/
const realFetch = globalThis.fetch
const text = (html: string, id: string) => new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1]

// A browser without JavaScript, keeping its own cookies.
const browser = () => testSite({ root: ROOT, use: [auth.plugin] })

// Imported once a site has registered the .kay loader for the fixture, a project of its own beside kayjs-auth.
await browser()
const { enable, setUp, signOut } = await import('../src/routes/account/index.kay')
const { verify } = await import('../src/routes/two-factor.kay')
const { magic, password, register } = await import('../src/routes/login.kay')
const { spend } = await import('../src/routes/magic.kay')

afterEach(() => {
  globalThis.fetch = realFetch
})

test('kay check passes on the fixture, its links to kayjs-auth routes, its use of ctx.locals.auth and this test included', async () => {
  const check = Bun.spawn([process.execPath, join(ROOT, '..', '..', 'node_modules', '.bin', 'kay'), 'check'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

  expect(await new Response(check.stdout).text() + await new Response(check.stderr).text()).toMatch(CLEAN)
  expect(await check.exited).toBe(0)
}, 60_000)

describe('a kay site on kayjs-auth', () => {
  test('a visitor reaching the account is sent to sign in, and comes back once signed up with a password', async () => {
    const ada = await browser()

    expect(await ada.visit('/account')).toMatchObject({ url: '/login?redirect=%2Faccount', status: 200 })

    const account = await ada.submit(register, { email: 'ada@example.com', password: 'correct horse battery' }, { from: '/login' })

    expect(account).toMatchObject({ url: '/account', status: 200 })
    expect(text(account.html, 'account')).toBe('ada@example.com')

    await ada.submit(signOut, {}, { from: '/account' })

    expect(text((await ada.visit('/')).html, 'who')).toBe('Anonymous')
  })

  test('a password sign-in with two-factor goes through the code page', async () => {
    const ada = await browser()

    await ada.submit(register, { email: 'totp@example.com', password: 'correct horse battery' }, { from: '/login' })
    const secret = text((await ada.submit(setUp, { password: 'correct horse battery' }, { from: '/account' })).html, 'secret')!

    await ada.submit(enable, { code: await totpCode(secret, totpStep()) }, { from: '/account' })
    await ada.submit(signOut, {}, { from: '/account' })

    const visitor = await browser()

    expect(await visitor.submit(password, { identifier: 'totp@example.com', password: 'correct horse battery' }, { from: '/login' })).toMatchObject({ url: '/two-factor', status: 200 })
    expect(text((await visitor.submit(verify, { code: '000000' }, { from: '/two-factor' })).html, 'error')).toBe('invalid')

    const account = await visitor.submit(verify, { code: await totpCode(secret, totpStep() + 1) }, { from: '/two-factor' })

    expect(account).toMatchObject({ url: '/account', status: 200 })
    expect(text(account.html, 'account')).toBe('totp@example.com')
  })

  test('a magic link opens a page whose button signs in, so opening the link alone spends nothing', async () => {
    await (await browser()).submit(register, { email: 'magic@example.com', password: 'correct horse battery' }, { from: '/login' })

    const visitor = await browser()

    expect(text((await visitor.submit(magic, { email: 'magic@example.com' }, { from: '/login' })).html, 'sent')).toBe('Check your mail')

    const link = new URL(mails.findLast(mail => mail.kind === 'magic-link')!.url!)

    await (await browser()).visit(link.pathname + link.search)
    await visitor.visit(link.pathname + link.search)

    // The form carries the token in a hidden field, as the browser would post it.
    const account = await visitor.submit(spend, { token: link.searchParams.get('token')! }, { from: link.pathname + link.search })

    expect(account).toMatchObject({ url: '/account', status: 200 })
    expect(text(account.html, 'account')).toBe('magic@example.com')
  })

  test('the Discord link signs in through the provider and lands on the account', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith('/oauth2/token')
      ? Response.json({ access_token: 'token', expires_in: 3600 })
      : Response.json({ id: '42', username: 'discordian', email: 'discord@example.com', verified: true })) as typeof fetch

    const visitor = await browser()
    const leaving = await visitor.fetch('/auth/discord?redirect=/account')
    const location = new URL(leaving.headers.get('location')!)

    expect(location.href).toStartWith('https://discord.com/oauth2/authorize?')

    const account = await visitor.visit(`/auth/discord/callback?code=abc&state=${location.searchParams.get('state')}`)

    expect(account).toMatchObject({ url: '/account', status: 200 })
    expect(text(account.html, 'account')).toBe('discord@example.com')
  })
})
