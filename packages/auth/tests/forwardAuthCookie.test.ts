import type { AuthSessionData } from '../src/auth'
import type { ForwardAuthOptions, ForwardDomains } from '../src/forwardAuth'
import { describe, expect, test } from 'bun:test'
import { session } from 'kay/server'
import { SECRET, testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'
const PORTAL = 'https://auth.example.test'
const SIGNED_IN = /^kay_session=/

async function signInAt(url: string, forwardAuth: ForwardDomains | ForwardAuthOptions = 'example.test', sessionDomain?: string, headers: Record<string, string> = {}) {
  const { app, auth } = testApp({ site: PORTAL, forwardAuth, sessions: session<AuthSessionData>({ secret: SECRET, ...sessionDomain !== undefined && { domain: sessionDomain } }) })
  const made = await auth.createUser({ password: PASSWORD, emailVerified: true, username: 'ada' })

  if (!made.ok)
    throw new Error(JSON.stringify(made.errors))

  const response = await app.handle(new Request(new URL(`/sign-in/${made.user.id}`, url), { method: 'POST', headers }))
  const line = response.headers.getSetCookie().find(header => (/^(?:__Host-)?kay_session=/).test(header))!

  return { app, line, cookie: line.slice(0, line.indexOf(';')) }
}

describe('the session cookie of a portal forwarding auth', () => {
  test('carries the shared domain, with no __Host- prefix, on the portal, a sibling host and the domain itself', async () => {
    for (const url of ['https://auth.example.test', 'https://wiki.example.test', 'https://example.test', 'https://a.b.example.test'])
      expect((await signInAt(url)).line, url).toMatch(/^kay_session=.*; Domain=example\.test;/i)
  })

  test('is read back whatever Host the request carries, as a proxy asking from the portal\'s internal address sends', async () => {
    const { app, cookie } = await signInAt(PORTAL)
    const response = await app.handle(new Request('https://127.0.0.1:3000/me', { headers: { cookie } }))

    expect(await response.json()).toMatchObject({ username: 'ada' })
  })

  test('is read back by a sibling host', async () => {
    const { app, cookie } = await signInAt(PORTAL)
    const response = await app.handle(new Request('https://wiki.example.test/me', { headers: { cookie } }))

    expect(await response.json()).toMatchObject({ username: 'ada' })
  })

  test('takes the domain and the host in any case', async () => {
    expect((await signInAt('https://AUTH.Example.TEST', ' Example.TEST ')).line).toMatch(/; Domain=example\.test;/i)
  })

  test('shares under the listed domain the host is on', async () => {
    const domains = ['example.test', 'other.test']

    expect((await signInAt('https://auth.other.test', domains)).line).toMatch(/^kay_session=.*; Domain=other\.test;/i)
    expect((await signInAt(PORTAL, { domains })).line).toMatch(/^kay_session=.*; Domain=example\.test;/i)
  })

  test('stays the host\'s own, under the same name, on a host outside the domains', async () => {
    for (const url of ['https://elsewhere.test', 'https://example.test.evil.test', 'https://evilexample.test', 'https://example.test@evil.test', 'https://example.test.', 'https://localhost', 'http://localhost']) {
      const { line } = await signInAt(url)

      expect(line, url).not.toMatch(/Domain=/i)
      expect(line, url).toMatch(SIGNED_IN)
    }
  })

  test('keeps the domain the session names itself', async () => {
    expect((await signInAt(PORTAL, 'example.test', 'auth.example.test')).line).toMatch(/; Domain=auth\.example\.test;/i)
  })

  test('is set for the whole site, so a base path leaves it alone', async () => {
    expect((await signInAt(PORTAL)).line).toMatch(/; Path=\/;/i)
  })
})
