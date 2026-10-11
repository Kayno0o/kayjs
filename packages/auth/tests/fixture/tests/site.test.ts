import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { totpCode, totpStep } from '../../../src/totp'
import { mails, store } from '../src/auth'

// The fixture is served the way an app serves itself: kay's pages, kayjs-auth's plugin handed over by its extension and its prebuilt pages among them.
const ROOT = join(import.meta.dir, '..')
const PAGES = join(ROOT, '..', '..', 'src', 'pages', 'routes')
// kay check prints this line on success since kay 1.18, nothing before.
const CLEAN = /^(?:checked with no problems in \d+ ms\n)?$/
const PASSWORD = 'correct horse battery'
const realFetch = globalThis.fetch

// A browser without JavaScript, keeping its own cookies.
const browser = () => testSite({ root: ROOT })

// Imported once a site has registered the .kay loader for the fixture, a project of its own beside kayjs-auth.
await browser()
const { signOut } = await import(join(PAGES, 'account', '_layout.kay'))
const { changeEmail } = await import(join(PAGES, 'account', 'index.kay'))
const { disable, enable, setUp } = await import(join(PAGES, 'account', 'security.kay'))
const { end, endOthers } = await import(join(PAGES, 'account', 'sessions.kay'))
const { create, revoke } = await import(join(PAGES, 'account', 'tokens.kay'))
const { remove } = await import(join(PAGES, 'account', 'data.kay'))
const { confirm } = await import(join(PAGES, 'confirm-email.kay'))
const { magicLink, password } = await import(join(PAGES, 'sign-in.kay'))
const { register } = await import(join(PAGES, 'register.kay'))
const { request, reset } = await import(join(PAGES, 'reset-password.kay'))
const { verify } = await import(join(PAGES, 'two-factor.kay'))
const { verify: verifyEmail } = await import(join(PAGES, 'verify-email.kay'))
const { spend } = await import('../src/routes/auth/magic-link.kay')
const { rename } = await import('../src/routes/orgs/[org]/index.kay')

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof browser>>['visit']>>

const text = (page: Page, selector: string) => page.find(selector)[0]?.text

// A visitor who registered from the account's sign-in redirect, landing on their account.
async function signedUp(email: string) {
  const visitor = await browser()
  const account = await visitor.submit(register, { email, password: PASSWORD, redirect: '/auth/account' }, { from: '/auth/register?redirect=%2Fauth%2Faccount' })

  expect(account).toMatchObject({ url: '/auth/account', status: 200 })

  return visitor
}

const lastLink = (kind: string) => new URL(mails.findLast(mail => mail.kind === kind)!.url!)

afterEach(() => {
  globalThis.fetch = realFetch
})

test('kay check passes on the fixture, its links to kayjs-auth routes, its use of ctx.locals.auth and this test included', async () => {
  const check = Bun.spawn([process.execPath, join(ROOT, '..', '..', 'node_modules', '.bin', 'kay'), 'check'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

  // A run the timeout cuts short leaves no check behind.
  try {
    expect(await new Response(check.stdout).text() + await new Response(check.stderr).text()).toMatch(CLEAN)
    expect(await check.exited).toBe(0)
  }
  finally {
    check.kill()
  }
}, 60_000)

describe('the prebuilt pages', () => {
  test('a visitor reaching the account is sent to sign in, and comes back once registered', async () => {
    const ada = await browser()

    expect(await ada.visit('/auth/account')).toMatchObject({ url: '/auth/sign-in?redirect=%2Fauth%2Faccount', status: 200 })

    const account = await ada.submit(register, { email: 'ada@example.com', password: PASSWORD, redirect: '/auth/account' }, { from: '/auth/register?redirect=%2Fauth%2Faccount' })

    expect(text(account, '#kayjs-auth-email')).toBe('ada@example.com')
    expect(await ada.submit(signOut, {}, { from: '/auth/account' })).toMatchObject({ url: '/' })
    expect(text(await ada.visit('/'), '#who')).toBe('Anonymous')
  })

  test('the pages reached before signing in open under the app\'s guard asking for a session, which keeps its own pages', async () => {
    const visitor = await browser()

    for (const path of ['/auth/sign-in', '/auth/register', '/auth/reset-password', '/auth/two-factor', '/auth/verify-email', '/auth/confirm-email', '/fr/auth/sign-in'])
      expect(await visitor.visit(path)).toMatchObject({ url: path, status: 200 })

    expect(await visitor.visit('/members')).toMatchObject({ url: '/auth/sign-in?redirect=%2Fmembers', status: 200 })
  })

  test('kayjs-auth\'s own magic-link page, which the fixture replaces, opens under the same guard on a site replacing none, and spends the mailed link', async () => {
    const run = Bun.spawn([process.execPath, join(import.meta.dir, 'shipped.ts')], { stdout: 'pipe', stderr: 'pipe' })
    let out: string

    // A run the timeout cuts short leaves no site behind.
    try {
      const [printed, errors] = [await new Response(run.stdout).text(), await new Response(run.stderr).text()]

      out = printed
      expect({ errors, exited: await run.exited }).toEqual({ errors: '', exited: 0 })
    }
    finally {
      run.kill()
    }

    const { link, ...steps } = JSON.parse(out) as { link: string }

    expect(link).toStartWith('/auth/magic-link?token=')
    expect(steps).toEqual({
      registered: { url: '/auth/account', status: 200 },
      opened: { url: link, status: 200, buttons: ['Sign in'] },
      spent: { url: '/auth/account', status: 200 },
    })
  }, 60_000)

  test('a refused registration says why, field by field', async () => {
    await signedUp('taken@example.com')

    const refused = await (await browser()).submit(register, { email: 'taken@example.com', password: 'short' }, { from: '/auth/register' })

    expect(refused.status).toBe(400)
    expect(refused.find('.kui-form-field-issue').map(issue => issue.text)).toEqual(['An account already uses this address.', 'Use at least 10 characters.'])
  })

  test('a wrong password is refused with a message, and the right one signs in to where the visitor was going', async () => {
    await (await signedUp('grace@example.com')).submit(signOut, {}, { from: '/auth/account' })

    const visitor = await browser()
    const refused = await visitor.submit(password, { identifier: 'grace@example.com', password: 'wrong password', redirect: '/auth/account' }, { from: '/auth/sign-in' })

    expect(text(refused, '[role="alert"]')).toBe('Wrong email, username or password.')
    expect(await visitor.submit(password, { identifier: 'grace@example.com', password: PASSWORD, redirect: '/auth/account' }, { from: '/auth/sign-in' })).toMatchObject({ url: '/auth/account' })
  })

  test('two-factor is set up from the security page, and a password sign-in then goes through the code page', async () => {
    const ada = await signedUp('totp@example.com')
    const scan = await ada.submit(setUp, { password: PASSWORD }, { from: '/auth/account/security' })
    const secret = text(scan, '#kayjs-auth-key')!
    const uri = scan.find('input[name="uri"]')[0]!.attributes.value!

    expect(scan.find('img.kui-qr-code')).toHaveLength(1)

    // A wrong code shows the same QR code again.
    expect(text(await ada.submit(enable, { code: '000000', uri }, { from: '/auth/account/security' }), '#kayjs-auth-key')).toBe(secret)

    const enabled = await ada.submit(enable, { code: await totpCode(secret, totpStep()), uri }, { from: '/auth/account/security' })

    const recoveryCodes = enabled.find('#kayjs-auth-recovery-codes li').map(code => code.text)

    expect(recoveryCodes).toHaveLength(10)
    await ada.submit(signOut, {}, { from: '/auth/account' })

    const visitor = await browser()

    expect(await visitor.submit(password, { identifier: 'totp@example.com', password: PASSWORD, redirect: '/auth/account' }, { from: '/auth/sign-in' })).toMatchObject({ url: '/auth/two-factor', status: 200 })
    expect(text(await visitor.submit(verify, { code: '000000' }, { from: '/auth/two-factor' }), '[role="alert"]')).toBe('Wrong code.')

    const account = await visitor.submit(verify, { code: await totpCode(secret, totpStep() + 1) }, { from: '/auth/two-factor' })

    expect(text(account, '#kayjs-auth-email')).toBe('totp@example.com')

    // Both codes of the authenticator were spent, so a recovery code proves the second factor.
    const off = await visitor.submit(disable, { code: recoveryCodes[0]! }, { from: '/auth/account/security' })

    expect(off.find('.kui-badge').map(badge => badge.text)).toContain('Off')
  })

  test('a magic link is mailed from the sign-in page and spent through the app\'s own page at that path', async () => {
    await (await signedUp('magic@example.com')).submit(signOut, {}, { from: '/auth/account' })

    const visitor = await browser()

    expect(text(await visitor.submit(magicLink, { email: 'magic@example.com', redirect: '/auth/account' }, { from: '/auth/sign-in' }), '[role="status"]')).toBe('If an account has this address, a mail is on its way.')

    const link = lastLink('magic-link')

    expect(link.pathname).toBe('/auth/magic-link')

    // Opening the link alone spends nothing: the app's page only shows a button.
    await (await browser()).visit(link.pathname + link.search)

    const account = await visitor.submit(spend, { token: link.searchParams.get('token')! }, { from: link.pathname + link.search })

    expect(text(account, '#kayjs-auth-email')).toBe('magic@example.com')
  })

  test('a forgotten password is reset through the mailed link', async () => {
    await (await signedUp('reset@example.com')).submit(signOut, {}, { from: '/auth/account' })

    const visitor = await browser()

    expect(text(await visitor.submit(request, { email: 'reset@example.com' }, { from: '/auth/reset-password' }), '[role="status"]')).toStartWith('If an account has this address')

    const link = lastLink('reset-password')
    const form = await visitor.visit(link.pathname + link.search)

    expect(text(form, 'h1')).toBe('Choose a new password')
    expect(text(await visitor.submit(reset, { token: link.searchParams.get('token')!, password: 'short' }, { from: form }), '.kui-form-field-issue')).toBe('Use at least 10 characters.')
    expect(await visitor.submit(reset, { token: link.searchParams.get('token')!, password: 'a brand new passphrase' }, { from: link.pathname + link.search })).toMatchObject({ url: '/' })
    expect(text(await visitor.visit('/'), '#who')).toBe('Signed in as reset@example.com')
  })

  test('the address is verified through the mailed link, and changed through a confirmation sent to the new one', async () => {
    const ada = await signedUp('verify@example.com')
    const verification = lastLink('verify-email')

    expect(verification.pathname).toBe('/auth/verify-email')
    await ada.submit(verifyEmail, { token: verification.searchParams.get('token')! }, { from: verification.pathname + verification.search })
    expect((await ada.visit('/auth/account')).find('.kui-badge').map(badge => badge.text)).toContain('Verified')

    const sent = await ada.submit(changeEmail, { email: 'moved@example.com', password: PASSWORD }, { from: '/auth/account' })

    expect(text(sent, '[role="status"]')).toBe('Open the link mailed to moved@example.com to confirm it.')

    const change = lastLink('change-email')

    expect(change.pathname).toBe('/auth/confirm-email')
    await ada.submit(confirm, { token: change.searchParams.get('token')! }, { from: change.pathname + change.search })
    expect(text(await ada.visit('/auth/account'), '#kayjs-auth-email')).toBe('moved@example.com')
  })

  test('the sessions page lists each device and signs out the others', async () => {
    const ada = await signedUp('sessions@example.com')
    const phone = await browser()

    await phone.submit(password, { identifier: 'sessions@example.com', password: PASSWORD }, { from: '/auth/sign-in' })

    const listed = await ada.visit('/auth/account/sessions')

    expect(listed.find('[data-session]')).toHaveLength(2)
    await ada.submit(endOthers, {}, { from: '/auth/account/sessions' })
    expect(text(await phone.visit('/'), '#who')).toBe('Anonymous')

    const [own] = (await ada.visit('/auth/account/sessions')).find('[data-session]')

    expect(await ada.submit(end, { id: own!.attributes['data-session']! }, { from: '/auth/account/sessions' })).toMatchObject({ url: '/' })
    expect(text(await ada.visit('/'), '#who')).toBe('Anonymous')
  })

  test('a token is shown once on creation, then listed until revoked', async () => {
    const ada = await signedUp('tokens@example.com')
    const created = await ada.submit(create, { label: 'CI', days: '30', password: PASSWORD }, { from: '/auth/account/tokens' })

    expect(text(created, '#kayjs-auth-token')).toBeString()

    const [token] = (await ada.visit('/auth/account/tokens')).find('[data-token]')

    expect((await ada.visit('/auth/account/tokens')).find('#kayjs-auth-token')).toHaveLength(0)
    await ada.submit(revoke, { id: token!.attributes['data-token']! }, { from: '/auth/account/tokens' })
    expect((await ada.visit('/auth/account/tokens')).find('[data-token]')).toHaveLength(0)
  })

  test('the data page downloads the user\'s data and deletes the account once proved', async () => {
    const ada = await signedUp('leaving@example.com')
    const download = await ada.fetch('/auth/export')

    expect(await download.json()).toMatchObject({ user: { email: 'leaving@example.com' } })
    expect(text(await ada.submit(remove, { password: 'wrong password' }, { from: '/auth/account/data' }), '[role="alert"]')).toBe('Wrong password or code.')
    expect(await ada.submit(remove, { password: PASSWORD }, { from: '/auth/account/data' })).toMatchObject({ url: '/' })
    expect(await store.users.findByEmail('leaving@example.com')).toBeUndefined()
  })

  test('the app replaces one text and keeps the rest, and each language reads its own', async () => {
    const visitor = await browser()

    expect(text(await visitor.visit('/auth/sign-in'), 'h1')).toBe('Welcome back')
    expect(text(await visitor.visit('/fr/auth/sign-in'), 'h1')).toBe('Connexion')
    expect(text(await visitor.visit('/fr/auth/register'), 'h1')).toBe('Créer un compte')
  })

  test('the sign-in page shows what the config enables, and why a provider sign-in failed', async () => {
    const page = await (await browser()).visit('/auth/sign-in?error=cancelled')

    expect(page.find('a.kui-btn').map(link => link.attributes.href)).toEqual(['/auth/discord?redirect=%2F'])
    expect(page.find('input[name="email"]')).toHaveLength(1)
    expect(text(page, '[role="alert"]')).toBe('The sign-in was cancelled.')
  })

  test('the Discord button signs in through the provider', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith('/oauth2/token')
      ? Response.json({ access_token: 'token', expires_in: 3600 })
      : Response.json({ id: '42', username: 'discordian', email: 'discord@example.com', verified: true })) as typeof fetch

    const visitor = await browser()
    const leaving = await visitor.fetch('/auth/discord?redirect=/auth/account')
    const location = new URL(leaving.headers.get('location')!)

    expect(location.href).toStartWith('https://discord.com/oauth2/authorize?')

    const account = await visitor.visit(`/auth/discord/callback?code=abc&state=${location.searchParams.get('state')}`)

    expect(account).toMatchObject({ url: '/auth/account', status: 200 })
    expect(text(account, '#kayjs-auth-email')).toBe('discord@example.com')
  })
})

test('an organization\'s guard reads its route\'s param, for its page and its actions alike', async () => {
  const member = async (email: string, roles?: string[]) => {
    const visitor = await signedUp(email)
    const { id } = (await store.users.findByEmail(email))!

    if (roles)
      await store.members!.add({ organizationId: 'o1', userId: id, roles, createdAt: new Date() })

    return visitor
  }

  await store.organizations!.create({ id: 'o1', name: 'Acme', slug: 'acme', createdAt: new Date() })

  const ada = await member('org-admin@example.com', ['admin'])
  const grace = await member('org-member@example.com', ['member'])
  const alan = await member('org-stranger@example.com')

  expect(text(await ada.visit('/orgs/acme'), '#organization')).toBe('Acme')
  expect((await grace.visit('/orgs/acme')).status).toBe(403)
  expect((await alan.visit('/orgs/o1')).status).toBe(403)
  expect(await (await browser()).visit('/orgs/acme')).toMatchObject({ url: '/auth/sign-in?redirect=%2Forgs%2Facme' })

  expect(await ada.call(rename, { name: 'Acme Inc' }, { from: '/orgs/acme' })).toBe('Acme Inc')
  await expect(grace.call(rename, { name: 'Taken' }, { from: '/orgs/acme' })).rejects.toThrow()
  expect((await store.organizations!.get('o1'))!.name).toBe('Acme Inc')
})
