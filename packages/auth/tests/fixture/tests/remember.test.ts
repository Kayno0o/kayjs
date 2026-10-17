import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { mails, store } from '../src/auth'

// "Keep me signed in" on the prebuilt pages: one lifetime per choice, whichever way the visitor signs in.
const ROOT = join(import.meta.dir, '..')
const PAGES = join(ROOT, '..', '..', 'src', 'pages', 'routes')
const PASSWORD = 'correct horse battery'
const DAY = 24 * 60 * 60
const REMEMBERED = 90 * DAY

const browser = () => testSite({ root: ROOT })

await browser()
const { magicLink, password } = await import(join(PAGES, 'sign-in.kay'))
const { register } = await import(join(PAGES, 'register.kay'))
const { spend } = await import('../src/routes/auth/magic-link.kay')

// The lifetime of the newest session the address signed in with, in seconds unseen.
async function lifetimeOf(email: string): Promise<number | null> {
  const user = await store.users.findByEmail(email)
  const sessions = await store.sessions.listByUser(user!.id)

  return sessions.toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!.maxAge
}

describe('the sign-in page', () => {
  test('shows the box in the password form and the magic link form, and links every provider as not remembered', async () => {
    const page = await (await browser()).visit('/auth/sign-in')

    expect(page.find('input[name="remember"]')).toHaveLength(2)
    expect(page.find('a[data-provider]').map(link => link.attributes.href)).toEqual(['/auth/discord?redirect=%2F&remember=0'])
  })

  test('the register page shows the box and the same provider links', async () => {
    const page = await (await browser()).visit('/auth/register')

    expect(page.find('input[name="remember"]')).toHaveLength(1)
    expect(page.find('a[data-provider]').map(link => link.attributes.href)).toEqual(['/auth/discord?redirect=%2F&remember=0'])
  })
})

describe('the lifetime of a sign-in', () => {
  test('registering and signing in by password last a day unchecked and rememberMaxAge checked', async () => {
    const signUp = await browser()

    await signUp.submit(register, { email: 'remember-ada@example.com', password: PASSWORD }, { from: await signUp.visit('/auth/register') })
    expect(await lifetimeOf('remember-ada@example.com')).toBe(DAY)

    const checked = await browser()

    await checked.submit(register, { email: 'remember-grace@example.com', password: PASSWORD, remember: 'on' }, { from: await checked.visit('/auth/register') })
    expect(await lifetimeOf('remember-grace@example.com')).toBe(REMEMBERED)

    const unchecked = await browser()

    await unchecked.submit(password, { identifier: 'remember-grace@example.com', password: PASSWORD }, { from: await unchecked.visit('/auth/sign-in') })
    expect(await lifetimeOf('remember-grace@example.com')).toBe(DAY)

    const again = await browser()

    await again.submit(password, { identifier: 'remember-grace@example.com', password: PASSWORD, remember: 'on' }, { from: await again.visit('/auth/sign-in') })
    expect(await lifetimeOf('remember-grace@example.com')).toBe(REMEMBERED)
  })

  test('a magic link lasts a day unchecked, as a password does, and rememberMaxAge checked', async () => {
    const signUp = await browser()

    await signUp.submit(register, { email: 'remember-magic@example.com', password: PASSWORD }, { from: await signUp.visit('/auth/register') })

    for (const [remember, expected] of [[undefined, DAY], ['on', REMEMBERED]] as const) {
      const visitor = await browser()

      await visitor.submit(magicLink, { email: 'remember-magic@example.com', ...(remember && { remember }) }, { from: await visitor.visit('/auth/sign-in') })

      const link = new URL(mails.findLast(mail => mail.kind === 'magic-link')!.url!)

      await visitor.submit(spend, { token: link.searchParams.get('token')! }, { from: link.pathname + link.search })
      expect(await lifetimeOf('remember-magic@example.com')).toBe(expected)
    }
  })
})

describe('a provider sign-in', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('lasts a day on the page\'s default link and rememberMaxAge on the link a checked box leads to', async () => {
    for (const [remember, expected, id] of [[0, DAY, '71'], [1, REMEMBERED, '72']] as const) {
      globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith('/oauth2/token')
        ? Response.json({ access_token: 'token', expires_in: 3600 })
        : Response.json({ id, username: `discord${id}`, email: `discord${id}@example.com`, verified: true })) as typeof fetch

      const visitor = await browser()
      const leaving = await visitor.fetch(`/auth/discord?redirect=/auth/account&remember=${remember}`)
      const state = new URL(leaving.headers.get('location')!).searchParams.get('state')

      await visitor.visit(`/auth/discord/callback?code=abc&state=${state}`)
      expect(await lifetimeOf(`discord${id}@example.com`)).toBe(expected)
    }
  })
})
