import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuth, oauthProvider, safeRedirect } from '../../plugin-auth/src/index'
import { sqliteAuthStore } from '../../plugin-auth/src/sqlite'
import { mailer } from '../../plugin-mail/src/index'
import { testApp } from '../src/test/index'

const TMP = join(tmpdir(), `kay-v2-auth-${Date.now()}`)

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('@kayjs/auth — Zero-dependency Bun-native Auth plugin', () => {
  test('safeRedirect rejects open redirects and preserves relative paths', () => {
    expect(safeRedirect('/dashboard?tab=1')).toBe('/dashboard?tab=1')
    expect(safeRedirect('//evil.com')).toBe('/')
    expect(safeRedirect('https://evil.com/phish')).toBe('/')
    expect(safeRedirect('/\\evil.com')).toBe('/')
    expect(safeRedirect('/ok\r\nSet-Cookie: bad=1')).toBe('/')
  })

  test('full password signup/signin/signout, CSRF, guards, server action ctx.locals.user, magic link + @kayjs/mail, SQLite persistence, and OAuth2 + PKCE', async () => {
    const appDir = join(TMP, 'auth-app')
    const routesDir = join(appDir, 'src', 'routes')
    const dbPath = join(TMP, 'auth.sqlite')
    mkdirSync(join(routesDir, 'dashboard'), { recursive: true })
    mkdirSync(join(routesDir, 'admin'), { recursive: true })

    // Local mock OAuth2 + PKCE server
    let lastCodeChallenge = ''
    let lastVerifiedVerifier = ''
    let mockProfile = { id: 'oauth-42', email: 'oauth-user@example.com', emailVerified: true, name: 'OAuth User' }
    const mockOAuth = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/authorize') {
          lastCodeChallenge = url.searchParams.get('code_challenge') ?? ''
          const cb = new URL(url.searchParams.get('redirect_uri')!)
          cb.searchParams.set('code', 'mock-auth-code-123')
          cb.searchParams.set('state', url.searchParams.get('state') ?? '')
          return Response.redirect(cb.toString(), 302)
        }
        if (url.pathname === '/token' && req.method === 'POST') {
          const body = new URLSearchParams(await req.text())
          lastVerifiedVerifier = body.get('code_verifier') ?? ''
          if (body.get('code') !== 'mock-auth-code-123')
            return new Response('bad code', { status: 400 })
          return Response.json({ access_token: 'mock-access-token' })
        }
        if (url.pathname === '/userinfo') {
          if (req.headers.get('authorization') !== 'Bearer mock-access-token')
            return new Response('unauthorized', { status: 401 })
          return Response.json(mockProfile)
        }
        return new Response('not found', { status: 404 })
      },
    })

    const mockOrigin = `http://127.0.0.1:${mockOAuth.port}`
    const mail = mailer({ id: `auth-test-${Date.now()}` })
    const store = sqliteAuthStore(dbPath)
    const auth = createAuth({
      store,
      secret: 'test-auth-secret-32-chars-minimum',
      rateLimit: { max: 50, windowMs: 60_000 },
      sendMail: async (m) => {
        await mail.send({ to: m.to, subject: m.subject, text: m.text, html: m.html })
      },
      providers: [
        oauthProvider({
          id: 'mock',
          clientId: 'cid',
          clientSecret: 'csec',
          authorizeUrl: `${mockOrigin}/authorize`,
          tokenUrl: `${mockOrigin}/token`,
          scopes: ['openid', 'email'],
          pkce: true,
          async fetchProfile(accessToken) {
            const res = await fetch(`${mockOrigin}/userinfo`, {
              headers: { authorization: `Bearer ${accessToken}` },
            })
            return res.json() as Promise<{ id: string, email: string, emailVerified: boolean, name: string }>
          },
        }),
      ],
    })

    // Expose auth instance via globalThis so compiled test route files share the same guard/auth
    ;(globalThis as Record<string, unknown>).__TEST_AUTH = auth

    writeFileSync(join(routesDir, 'index.tsx'), `
      export default function Home({ locals }: { locals: { user?: { email: string } } }) {
        return <main><p id="who">{locals.user ? locals.user.email : 'guest'}</p></main>
      }
    `)

    writeFileSync(join(routesDir, 'dashboard', '_middleware.ts'), `
      import type { Auth } from '${join(import.meta.dir, '../../plugin-auth/src/index.ts')}'
      const auth = (globalThis as Record<string, Auth>).__TEST_AUTH!
      export default auth.guard({ redirectTo: '/login' })
    `)

    writeFileSync(join(routesDir, 'dashboard', 'index.tsx'), `
      import { action } from 'kay/server'
      import type { Auth } from '${join(import.meta.dir, '../../plugin-auth/src/index.ts')}'
      const auth = (globalThis as Record<string, Auth>).__TEST_AUTH!

      export const createNote = action(async (ctx) => {
        const user = auth.getUser(ctx)
        if (!user) return ctx.deny(401, 'Not signed in')
        return { author: user.email, role: user.role }
      })

      export default function Dashboard({ locals }: { locals: { user?: { email: string } } }) {
        return (
          <main>
            <h1>Dashboard for {locals.user?.email}</h1>
            <form action={createNote} method="post"><button type="submit">Post</button></form>
          </main>
        )
      }
    `)

    writeFileSync(join(routesDir, 'admin', '_middleware.ts'), `
      import type { Auth } from '${join(import.meta.dir, '../../plugin-auth/src/index.ts')}'
      const auth = (globalThis as Record<string, Auth>).__TEST_AUTH!
      export default auth.guard({ role: 'admin' })
    `)

    writeFileSync(join(routesDir, 'admin', 'index.tsx'), `
      import { action } from 'kay/server'

      export const purge = action(async () => ({ purged: true }))

      export default function Admin() {
        return <main><h1>Secret Admin</h1></main>
      }
    `)

    try {
      const app = await testApp({
        root: appDir,
        plugins: [auth.plugin],
      })

      // 1. Unauthenticated access to protected route redirects HTML and returns 401 for JSON
      const unauthHtml = await app.get('/dashboard')
      expect(unauthHtml.status).toBe(302)
      expect(unauthHtml.headers.get('location')).toBe('/login?next=%2Fdashboard')

      const unauthJson = await app.get('/dashboard', { accept: 'application/json' })
      expect(unauthJson.status).toBe(401)

      const guestSession = await (await app.get('/auth/session')).json() as { user: unknown }
      expect(guestSession.user).toBeNull()

      // 2. CSRF protection blocks cross-origin POST to /auth/signup
      const badCsrf = await app.post('/auth/signup', { email: 'a@b.com', password: 'password123' }, { origin: 'https://evil.example' })
      expect(badCsrf.status).toBe(403)

      // 3. Signup with password (Argon2id + SQLite + session cookie)
      const signupRes = await app.post('/auth/signup', {
        email: 'Alice@Example.com',
        password: 'super-secret-password',
        name: 'Alice',
      })
      expect(signupRes.status).toBe(201)
      const signupBody = await signupRes.json() as { ok: boolean, user: { email: string, passwordHash?: string } }
      expect(signupBody.ok).toBe(true)
      expect(signupBody.user.email).toBe('alice@example.com')
      expect(signupBody.user.passwordHash).toBeUndefined() // never leaked!
      expect(app.cookies.has('kay_session')).toBe(true)

      // 4. Dashboard renders with ctx.locals.user & server action sees ctx.locals.user via global middleware!
      const dashRes = await app.get('/dashboard')
      expect(dashRes.status).toBe(200)
      const dashHtml = await dashRes.text()
      expect(dashHtml).toContain('Dashboard for alice@example.com')

      const actionUrl = app.manifest!.actions.find(a => a.exportName === 'createNote')!.url
      const actionRes = await app.post(actionUrl, {})
      expect(actionRes.status).toBe(200)
      expect(await actionRes.json()).toEqual({ ok: true, data: { author: 'alice@example.com', role: 'user' } })

      // 5. Role guard blocks non-admin user with 403, on the page and on an action declared beside it
      const adminDenied = await app.get('/admin')
      expect(adminDenied.status).toBe(403)

      const purgeUrl = app.manifest!.actions.find(a => a.exportName === 'purge')!.url
      const purgeDenied = await app.post(purgeUrl, {})
      expect(purgeDenied.status).toBe(403)

      // 6. Sign out revokes session in SQLite and clears cookie
      const signoutRes = await app.post('/auth/signout', {})
      expect(signoutRes.status).toBe(200)
      expect(app.cookies.has('kay_session')).toBe(false)

      const afterSignout = await app.get('/dashboard')
      expect(afterSignout.status).toBe(302)

      // 7. Progressive <form> sign-in with wrong password fails 401; valid password sets cookie + 303 safe redirect
      const badPass = await app.post('/auth/signin', { email: 'alice@example.com', password: 'wrong-password' })
      expect(badPass.status).toBe(401)

      const formSignIn = await app.submit('/auth/signin', {
        email: 'alice@example.com',
        password: 'super-secret-password',
        redirect: '//evil.com',
      })
      expect(formSignIn.status).toBe(303)
      expect(formSignIn.headers.get('location')).toBe('/') // open redirect neutralized!
      expect(app.cookies.has('kay_session')).toBe(true)

      // 8. Admin role succeeds after promoting user + revoking all sessions works
      const alice = await store.getUserByEmail('alice@example.com')
      await store.updateUser(alice!.id, { role: 'admin' })
      const adminOk = await app.get('/admin')
      expect(adminOk.status).toBe(200)
      expect(await adminOk.text()).toContain('Secret Admin')

      await auth.revokeAllSessions(alice!.id)
      const revokedRes = await app.get('/admin')
      expect(revokedRes.status).toBe(401)

      // 9. Magic link via @kayjs/mail (single-use, verifies email, replay fails)
      app.clearCookies()
      const mlRes = await app.post('/auth/magic-link', { email: 'magic@example.com', redirect: '/dashboard' })
      expect(mlRes.status).toBe(200)
      expect(mail.outbox.length).toBe(1)
      const urlMatch = mail.outbox[0]!.text!.match(/http:\/\/localhost[^\s]+/)
      expect(urlMatch).not.toBeNull()
      const verifyPath = new URL(urlMatch![0]).pathname + new URL(urlMatch![0]).search

      const verifyRes = await app.get(verifyPath)
      expect(verifyRes.status).toBe(302)
      expect(verifyRes.headers.get('location')).toBe('/dashboard')

      const mlSession = await (await app.get('/auth/session')).json() as { user: { email: string, emailVerified: boolean } }
      expect(mlSession.user.email).toBe('magic@example.com')
      expect(mlSession.user.emailVerified).toBe(true)

      // Replaying the same magic link token must fail
      const replayRes = await app.get(verifyPath)
      expect(replayRes.status).toBe(400)

      // 9b. A sign-in link is never built from a foreign Host
      const foreignHost = await app.post('http://evil.example/auth/magic-link', { email: 'magic@example.com' }, { origin: 'http://evil.example' })
      expect(foreignHost.status).toBe(500)
      expect(mail.outbox.length).toBe(1)

      // 9c. Proving an address by magic link drops the password and sessions set before the proof (pre-account takeover)
      app.clearCookies()
      expect((await app.post('/auth/signup', { email: 'victim@example.com', password: 'attacker-password' })).status).toBe(201)
      const squatterCookie = app.cookies.get('kay_session')!
      app.clearCookies()
      await app.post('/auth/magic-link', { email: 'victim@example.com' })
      const victimLink = new URL(mail.outbox[0]!.text!.match(/http:\/\/localhost[^\s]+/)![0])
      expect((await app.get(victimLink.pathname + victimLink.search)).status).toBe(302)
      app.clearCookies()
      expect((await app.post('/auth/signin', { email: 'victim@example.com', password: 'attacker-password' })).status).toBe(401)
      app.cookies.set('kay_session', squatterCookie)
      expect(((await (await app.get('/auth/session')).json()) as { user: unknown }).user).toBeNull()

      // 10. OAuth 2.0 + PKCE (S256) full round-trip + state tampering rejection, onto an address squatted by password sign-up
      app.clearCookies()
      expect((await app.post('/auth/signup', { email: 'oauth-user@example.com', password: 'attacker-password', name: 'OAuth User' })).status).toBe(201)
      app.clearCookies()
      const startOAuth = await app.get('/auth/oauth/mock?redirect=/dashboard')
      expect(startOAuth.status).toBe(302)
      const authorizeLoc = startOAuth.headers.get('location')!
      expect(authorizeLoc).toContain('code_challenge_method=S256')
      expect(app.cookies.has('kay_session_oauth')).toBe(true)

      // Follow redirect to local mock provider -> gets callback URL
      const providerRes = await fetch(authorizeLoc, { redirect: 'manual' })
      expect(providerRes.status).toBe(302)
      const cbUrl = new URL(providerRes.headers.get('location')!)

      // Tampered state must be rejected (without losing test flow, check on fresh cookie copy)
      const tampered = await app.get(`${cbUrl.pathname}?code=mock-auth-code-123&state=forged-state`)
      expect(tampered.status).toBe(400)

      // Valid round-trip
      const startOAuth2 = await app.get('/auth/oauth/mock?redirect=/dashboard')
      const providerRes2 = await fetch(startOAuth2.headers.get('location')!, { redirect: 'manual' })
      const cbUrl2 = new URL(providerRes2.headers.get('location')!)
      const cbRes = await app.get(cbUrl2.pathname + cbUrl2.search)
      expect(cbRes.status).toBe(302)
      expect(cbRes.headers.get('location')).toBe('/dashboard')
      expect(lastCodeChallenge.length).toBeGreaterThan(20)
      expect(lastVerifiedVerifier.length).toBeGreaterThan(20)

      const oauthSess = await (await app.get('/auth/session')).json() as { user: { email: string, name: string } }
      expect(oauthSess.user.email).toBe('oauth-user@example.com')
      expect(oauthSess.user.name).toBe('OAuth User')
      app.clearCookies()
      expect((await app.post('/auth/signin', { email: 'oauth-user@example.com', password: 'attacker-password' })).status).toBe(401)

      // 10b. A provider account holding an unproven address loses its session and its link once the owner proves it
      async function oauthCallback() {
        const start = await app.get('/auth/oauth/mock')
        const atProvider = await fetch(start.headers.get('location')!, { redirect: 'manual' })
        const cb = new URL(atProvider.headers.get('location')!)
        return app.get(cb.pathname + cb.search)
      }
      mockProfile = { id: 'squatter-7', email: 'claimed@example.com', emailVerified: false, name: 'Squatter' }
      app.clearCookies()
      expect((await oauthCallback()).status).toBe(302)
      const oauthSquatterCookie = app.cookies.get('kay_session')!
      app.clearCookies()
      await app.post('/auth/magic-link', { email: 'claimed@example.com' })
      const claimLink = new URL(mail.outbox[0]!.text!.match(/http:\/\/localhost[^\s]+/)![0])
      expect((await app.get(claimLink.pathname + claimLink.search)).status).toBe(302)
      app.clearCookies()
      app.cookies.set('kay_session', oauthSquatterCookie)
      expect(((await (await app.get('/auth/session')).json()) as { user: unknown }).user).toBeNull()
      app.clearCookies()
      expect((await oauthCallback()).status).toBe(409)
      expect(((await (await app.get('/auth/session')).json()) as { user: unknown }).user).toBeNull()

      // 11. SQLite persistence survives re-opening the DB file
      store.db.close()
      const reopened = sqliteAuthStore(dbPath)
      const persisted = await reopened.getUserByEmail('oauth-user@example.com')
      expect(persisted?.name).toBe('OAuth User')
      reopened.db.close()
    }
    finally {
      mockOAuth.stop(true)
      delete (globalThis as Record<string, unknown>).__TEST_AUTH
    }
  })

  test('builds mailed sign-in links and OAuth callbacks from `site`, never from the request host', async () => {
    const appDir = join(TMP, 'site-app')
    mkdirSync(join(appDir, 'src', 'routes'), { recursive: true })
    writeFileSync(join(appDir, 'src', 'routes', 'index.tsx'), 'export default function Home() { return <main>ok</main> }')
    const mailed: string[] = []
    let tokenRedirectUri = null as string | null
    const tokenServer = Bun.serve({
      port: 0,
      async fetch(req) {
        tokenRedirectUri = new URLSearchParams(await req.text()).get('redirect_uri')
        return Response.json({ access_token: 't' })
      },
    })
    const auth = createAuth({
      secret: 'site-test-secret-32-chars-minimum',
      site: 'https://app.example/ignored/path',
      sendMail: (m) => { mailed.push(m.text) },
      providers: [oauthProvider({
        id: 'mock',
        clientId: 'cid',
        clientSecret: 'csec',
        authorizeUrl: 'https://provider.example/authorize',
        tokenUrl: `http://127.0.0.1:${tokenServer.port}/token`,
        scopes: ['email'],
        fetchProfile: async () => ({ id: '1', email: 'a@b.c', emailVerified: true }),
      })],
    })
    const app = await testApp({ root: appDir, plugins: [auth.plugin] })

    const res = await app.post('http://evil.example/auth/magic-link', { email: 'user@example.com' }, { 'origin': 'http://evil.example', 'x-forwarded-host': 'evil.example' })
    expect(res.status).toBe(200)
    expect(mailed[0]).toMatch(/https:\/\/app\.example\/auth\/magic-link\/verify\?/)
    expect(mailed[0]).not.toContain('evil.example')

    const start = await app.get('http://evil.example/auth/oauth/mock', { 'x-forwarded-host': 'evil.example' })
    const authorize = new URL(start.headers.get('location')!)
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://app.example/auth/oauth/mock/callback')
    await app.get(`http://evil.example/auth/oauth/mock/callback?code=c&state=${authorize.searchParams.get('state')}`)
    tokenServer.stop(true)
    expect(tokenRedirectUri).toBe('https://app.example/auth/oauth/mock/callback')
  })

  test('refuses a `site` that is not an http or https origin', () => {
    expect(() => createAuth({ secret: 's', site: 'javascript:alert(1)' })).toThrow('site')
    expect(() => createAuth({ secret: 's', site: 'ftp://app.example' })).toThrow('site')
    expect(() => createAuth({ secret: 's', site: 'http://app.example' })).not.toThrow()
  })

  test('rate-limits repeated failed sign-in attempts with 429', async () => {
    const appDir = join(TMP, 'rate-app')
    const routesDir = join(appDir, 'src', 'routes')
    mkdirSync(routesDir, { recursive: true })
    writeFileSync(join(routesDir, 'index.tsx'), 'export default function Home() { return <main>ok</main> }')

    const auth = createAuth({
      secret: 'rate-limit-test-secret',
      rateLimit: { max: 2, windowMs: 60_000 },
    })
    const app = await testApp({ root: appDir, plugins: [auth.plugin] })

    const r1 = await app.post('/auth/signin', { email: 'x@y.com', password: 'wrong' })
    const r2 = await app.post('/auth/signin', { email: 'x@y.com', password: 'wrong' })
    const r3 = await app.post('/auth/signin', { email: 'x@y.com', password: 'wrong' })
    expect(r1.status).toBe(401)
    expect(r2.status).toBe(401)
    expect(r3.status).toBe(429)

    // Reverse proxy HTTPS -> HTTP origin verification works with X-Forwarded-Proto
    const proxied = await app.post('/auth/signup', { email: 'proxy@example.com', password: 'password123' }, {
      'origin': 'https://3000.kevyn.fr',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': '3000.kevyn.fr',
    })
    expect(proxied.status).toBe(201)
  })
})
