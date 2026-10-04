import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from 'kay/server'
import { totpCode, totpStep } from '../src/totp'
import { auth, mails } from './fixture/src/auth'

// The fixture is served the way an app serves itself: kay-auth's plugin, then kay's pages.
let app: Elysia
const realFetch = globalThis.fetch
const ORIGIN = 'http://localhost'
const FORM = /<form id="([^"]+)"[^>]*action="([^"]+)"/g
const TEXT = (id: string) => new RegExp(`id="${id}"[^>]*>([^<]*)<`)

beforeAll(async () => {
  app = new Elysia().use(auth.plugin).use(await pages({ root: join(import.meta.dir, 'fixture'), dev: false, prebuilt: false })) as unknown as Elysia
})

afterEach(() => {
  globalThis.fetch = realFetch
})

// A browser without JavaScript: it keeps cookies, follows redirects on this site, and posts forms by their id.
function browser() {
  const cookies = new Map<string, string>()
  let html = ''

  const send = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)

    if (cookies.size > 0)
      headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '))

    const response = await app.handle(new Request(new URL(path, ORIGIN), { ...init, headers }))

    for (const line of response.headers.getSetCookie()) {
      const cookie = Bun.Cookie.parse(line)

      if (cookie.isExpired())
        cookies.delete(cookie.name)
      else
        cookies.set(cookie.name, cookie.value)
    }

    return response
  }

  const follow = async (response: Response, from: string) => {
    let current = response
    let path = from

    while (current.status >= 300 && current.status < 400) {
      const next = new URL(current.headers.get('location')!, new URL(path, ORIGIN))

      if (next.origin !== ORIGIN)
        return { path: next.href, status: current.status }

      path = next.pathname + next.search
      current = await send(path)
    }

    html = await current.text()

    return { path, status: current.status }
  }

  return {
    visit: async (path: string) => follow(await send(path), path),
    async submit(form: string, fields: Record<string, string>, from: string) {
      const action = [...html.matchAll(FORM)].find(match => match[1] === form)?.[2]

      if (!action)
        throw new Error(`no form #${form} on ${from}`)

      const body = new FormData()

      for (const [name, value] of Object.entries(fields))
        body.append(name, value)

      return follow(await send(action, { method: 'POST', body, headers: { origin: ORIGIN, referer: `${ORIGIN}${from}` } }), action)
    },
    text: (id: string) => TEXT(id).exec(html)?.[1],
  }
}

test('kay check passes on the fixture, its links to kay-auth routes and its use of ctx.locals.auth included', async () => {
  const check = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'node_modules', '.bin', 'kay'), 'check'], { cwd: join(import.meta.dir, 'fixture'), stdout: 'pipe', stderr: 'pipe' })

  expect(await new Response(check.stdout).text() + await new Response(check.stderr).text()).toBe('')
  expect(await check.exited).toBe(0)
}, 60_000)

describe('a kay site on kay-auth', () => {
  test('a visitor reaching the account is sent to sign in, and comes back once signed up with a password', async () => {
    const ada = browser()

    expect(await ada.visit('/account')).toEqual({ path: '/login?redirect=%2Faccount', status: 200 })
    expect(await ada.submit('register', { email: 'ada@example.com', password: 'correct horse battery' }, '/login')).toEqual({ path: '/account', status: 200 })
    expect(ada.text('account')).toBe('ada@example.com')

    await ada.submit('sign-out', {}, '/account')
    await ada.visit('/')

    expect(ada.text('who')).toBe('Anonymous')
  })

  test('a password sign-in with two-factor goes through the code page', async () => {
    const ada = browser()

    await ada.visit('/login')
    await ada.submit('register', { email: 'totp@example.com', password: 'correct horse battery' }, '/login')
    await ada.submit('set-up', { password: 'correct horse battery' }, '/account')

    const secret = ada.text('secret')!

    await ada.submit('enable', { code: await totpCode(secret, totpStep()) }, '/account')
    await ada.submit('sign-out', {}, '/account')

    const visitor = browser()

    await visitor.visit('/login')

    expect(await visitor.submit('password', { identifier: 'totp@example.com', password: 'correct horse battery' }, '/login')).toEqual({ path: '/two-factor', status: 200 })

    await visitor.submit('code', { code: '000000' }, '/two-factor')
    expect(visitor.text('error')).toBe('invalid')

    expect(await visitor.submit('code', { code: await totpCode(secret, totpStep() + 1) }, '/two-factor')).toEqual({ path: '/account', status: 200 })
    expect(visitor.text('account')).toBe('totp@example.com')
  })

  test('a magic link opens a page whose button signs in, so opening the link alone spends nothing', async () => {
    const ada = browser()

    await ada.visit('/login')
    await ada.submit('register', { email: 'magic@example.com', password: 'correct horse battery' }, '/login')

    const visitor = browser()

    await visitor.visit('/login')
    await visitor.submit('magic', { email: 'magic@example.com' }, '/login')
    expect(visitor.text('sent')).toBe('Check your mail')

    const link = new URL(mails.findLast(mail => mail.kind === 'magic-link')!.url!)

    await browser().visit(link.pathname + link.search)
    await visitor.visit(link.pathname + link.search)

    // The form carries the token in a hidden field, as the browser would post it.
    expect(await visitor.submit('spend', { token: link.searchParams.get('token')! }, link.pathname + link.search)).toEqual({ path: '/account', status: 200 })
    expect(visitor.text('account')).toBe('magic@example.com')
  })

  test('the Discord link signs in through the provider and lands on the account', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith('/oauth2/token')
      ? Response.json({ access_token: 'token', expires_in: 3600 })
      : Response.json({ id: '42', username: 'discordian', email: 'discord@example.com', verified: true })) as typeof fetch

    const visitor = browser()
    const leaving = await visitor.visit('/auth/discord?redirect=/account')
    const state = new URL(leaving.path).searchParams.get('state')

    expect(leaving.path).toStartWith('https://discord.com/oauth2/authorize?')
    expect(await visitor.visit(`/auth/discord/callback?code=abc&state=${state}`)).toEqual({ path: '/account', status: 200 })
    expect(visitor.text('account')).toBe('discord@example.com')
  })
})
