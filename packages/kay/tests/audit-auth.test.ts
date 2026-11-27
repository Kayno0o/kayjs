import type { AuthStore } from '../../plugin-auth/src/store'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { Window } from 'happy-dom'
import { createAuth, createRateLimiter, discord, github, google, memoryAuthStore, oauthProvider } from '../../plugin-auth/src/index'
import { sqliteAuthStore } from '../../plugin-auth/src/sqlite'
import { scaffoldProject } from '../src/cli/new'
import { testApp } from '../src/test/index'

const TMP = join(tmpdir(), `kay-v2-audit-auth-${Date.now()}`)

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

function makeMinimalApp(name: string): string {
  const dir = join(TMP, name)
  mkdirSync(join(dir, 'src', 'routes'), { recursive: true })
  writeFileSync(join(dir, 'src', 'routes', 'index.tsx'), 'export default function Home() { return <main>ok</main> }')
  return dir
}

interface ConfirmForm { method: string | null, action: string | null, fields: Record<string, string>, buttons: number, scripts: number, styles: number }

// Reads the one form a mailed link's confirm page shows, as a browser parses it, and counts what a strict CSP would block.
async function readConfirmForm(res: Response): Promise<ConfirmForm> {
  const win = new Window()
  try {
    const doc = new win.DOMParser().parseFromString(await res.text(), 'text/html')
    const formEl = doc.querySelector('form')!
    const fields: Record<string, string> = {}
    for (const input of doc.querySelectorAll('input[type="hidden"]'))
      fields[input.getAttribute('name')!] = input.getAttribute('value')!
    return {
      method: formEl.getAttribute('method'),
      action: formEl.getAttribute('action'),
      fields,
      buttons: doc.querySelectorAll('button').length,
      scripts: doc.querySelectorAll('script').length,
      styles: doc.querySelectorAll('style, [style]').length,
    }
  }
  finally {
    await win.happyDOM.close()
  }
}

// Posts a confirm page's form back to the link it was opened from, as a browser without JS would.
function submitConfirmForm(app: Awaited<ReturnType<typeof testApp>>, link: string, form: ConfirmForm): Promise<Response> {
  const body = new FormData()
  for (const [name, value] of Object.entries(form.fields))
    body.append(name, value)
  const url = new URL(link)
  return app.post(url.pathname + url.search, body)
}

describe('Audit #3526 Batch 4 — Auth, Scaffold & RGPD', () => {
  describe('Box 11: Sign-up does not open a session before email verification', () => {
    test('POST /auth/signup creates unverified user without session, rejects signin until verified, opens session on GET /auth/verify-email', async () => {
      const appDir = makeMinimalApp('box11-get-verify')
      const mailed: Array<{ to: string, kind: string, url: string }> = []
      const auth = createAuth({
        secret: 'audit-box11-secret-32-bytes-minimum!!',
        site: 'https://app.example',
        sendMail: (m) => {
          mailed.push({ to: m.to, kind: m.kind, url: m.url })
        },
      })
      try {
        const app = await testApp({ root: appDir, plugins: [auth] })

        const signupRes = await app.post('/auth/signup', {
          email: 'Alice@Example.com',
          password: 'strong-password-123',
          name: 'Alice',
          redirect: '/welcome',
        })
        expect(signupRes.status).toBe(202)
        const signupBody = await signupRes.json() as {
          ok: boolean
          verificationRequired?: boolean
          user?: { email: string, emailVerified: boolean, passwordHash?: string }
        }
        expect(signupBody.ok).toBe(true)
        expect(signupBody.verificationRequired).toBe(true)
        expect(signupBody.user).toBeUndefined()
        const storedAlice = await auth.store.getUserByEmail('alice@example.com')
        expect(storedAlice?.email).toBe('alice@example.com')
        expect(storedAlice?.emailVerified).toBe(false)
        // No session cookie was set
        expect(app.cookies.has('kay_session')).toBe(false)
        expect(signupRes.headers.getSetCookie()).toEqual([])

        // Session endpoint reports unauthenticated
        const sessBefore = await (await app.get('/auth/session')).json() as { user: unknown }
        expect(sessBefore.user).toBeNull()

        // Verification mail was sent using configured `site`
        expect(mailed.length).toBe(1)
        expect(mailed[0]!.to).toBe('alice@example.com')
        expect(mailed[0]!.kind).toBe('verify-email')
        expect(mailed[0]!.url).toMatch(/^https:\/\/app\.example\/auth\/verify-email\?token=/)

        // Sign-in with wrong password still returns 401 (no account status leak on bad password)
        const badPass = await app.post('/auth/signin', { email: 'alice@example.com', password: 'wrong-password' })
        expect(badPass.status).toBe(401)

        // Sign-in with right password refuses unverified account with 403 and no cookie
        const unverifiedSignin = await app.post('/auth/signin', { email: 'alice@example.com', password: 'strong-password-123' })
        expect(unverifiedSignin.status).toBe(403)
        expect(app.cookies.has('kay_session')).toBe(false)

        // Opening the verification link (twice, as a mail scanner then the person would) only shows a confirm page
        const verifyUrl = new URL(mailed[0]!.url)
        await app.get(verifyUrl.pathname + verifyUrl.search)
        const page = await app.get(verifyUrl.pathname + verifyUrl.search)
        expect(page.status).toBe(200)
        expect(app.cookies.has('kay_session')).toBe(false)
        const form = await readConfirmForm(page)

        // Its button verifies the email and opens a session
        const verifyRes = await submitConfirmForm(app, mailed[0]!.url, form)
        expect(verifyRes.status).toBe(303)
        expect(verifyRes.headers.get('location')).toBe('/welcome')
        expect(app.cookies.has('kay_session')).toBe(true)

        const sessAfter = await (await app.get('/auth/session')).json() as { user: { email: string, emailVerified: boolean } }
        expect(sessAfter.user.email).toBe('alice@example.com')
        expect(sessAfter.user.emailVerified).toBe(true)

        // Replaying the verification token fails
        app.clearCookies()
        const replay = await submitConfirmForm(app, mailed[0]!.url, form)
        expect(replay.status).toBe(400)
        expect(app.cookies.has('kay_session')).toBe(false)

        // Sign-in now succeeds for the verified account
        const verifiedSignin = await app.post('/auth/signin', { email: 'alice@example.com', password: 'strong-password-123' })
        expect(verifiedSignin.status).toBe(200)
        expect(app.cookies.has('kay_session')).toBe(true)
      }
      finally {
        auth.dispose()
      }
    })

    test('POST /auth/verify-email verifies token and returns 200 JSON with session cookie', async () => {
      const appDir = makeMinimalApp('box11-post-verify')
      let sentUrl = ''
      const auth = createAuth({
        secret: 'audit-box11-post-secret-32-bytes-min!',
        sendMail: (m) => { sentUrl = m.url },
      })
      try {
        const app = await testApp({ root: appDir, plugins: [auth] })
        const signupRes = await app.post('/auth/signup', { email: 'bob@example.com', password: 'password1234' })
        expect(signupRes.status).toBe(202)
        expect(app.cookies.has('kay_session')).toBe(false)

        const token = new URL(sentUrl).searchParams.get('token')!
        const verifyRes = await app.post('/auth/verify-email', { token })
        expect(verifyRes.status).toBe(200)
        const body = await verifyRes.json() as { ok: boolean, user: { email: string, emailVerified: boolean } }
        expect(body.ok).toBe(true)
        expect(body.user.email).toBe('bob@example.com')
        expect(body.user.emailVerified).toBe(true)
        expect(app.cookies.has('kay_session')).toBe(true)
      }
      finally {
        auth.dispose()
      }
    })

    test('opening a magic link twice leaves it valid; its page posts once without JS, inline script or style (#3656)', async () => {
      const appDir = makeMinimalApp('magic-confirm')
      const mailed: string[] = []
      const auth = createAuth({
        secret: 'audit-3656-magic-secret-32-bytes-min!',
        site: 'https://app.example',
        sendMail: (m) => { mailed.push(m.url) },
      })
      try {
        const app = await testApp({ root: appDir, plugins: [auth] })
        await app.post('/auth/magic-link', { email: 'carol@example.com', redirect: '/inbox' })
        const link = new URL(mailed[0]!)

        await app.get(link.pathname + link.search)
        const page = await app.get(link.pathname + link.search)
        expect(page.status).toBe(200)
        expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
        expect(page.headers.get('cache-control')).toBe('no-store')
        expect(app.cookies.has('kay_session')).toBe(false)
        expect(await auth.store.getUserByEmail('carol@example.com')).toBeUndefined()

        const form = await readConfirmForm(page)
        expect(form).toEqual({
          method: 'post',
          action: null,
          fields: { token: link.searchParams.get('token')!, redirect: '/inbox' },
          buttons: 1,
          scripts: 0,
          styles: 0,
        })

        const signin = await submitConfirmForm(app, mailed[0]!, form)
        expect(signin.status).toBe(303)
        expect(signin.headers.get('location')).toBe('/inbox')
        expect(app.cookies.has('kay_session')).toBe(true)
        expect((await auth.store.getUserByEmail('carol@example.com'))?.emailVerified).toBe(true)

        app.clearCookies()
        const replay = await submitConfirmForm(app, mailed[0]!, form)
        expect(replay.status).toBe(400)
        expect(app.cookies.has('kay_session')).toBe(false)
      }
      finally {
        auth.dispose()
      }
    })

    test('a mailed link page escapes the redirect it carries, and its POST refuses an open redirect (#3656)', async () => {
      const appDir = makeMinimalApp('magic-confirm-escape')
      const mailed: string[] = []
      const auth = createAuth({
        secret: 'audit-3656-escape-secret-32-bytes-mn!',
        site: 'https://app.example',
        sendMail: (m) => { mailed.push(m.url) },
      })
      try {
        const app = await testApp({ root: appDir, plugins: [auth] })
        const page = await app.get(`/auth/magic-link/verify?token=t&redirect=${encodeURIComponent('/a?x="><script>alert(1)</script>')}`)
        const form = await readConfirmForm(page)
        expect(form.scripts).toBe(0)
        expect(form.fields).toEqual({ token: 't', redirect: '/a?x="><script>alert(1)</script>' })

        await app.post('/auth/magic-link', { email: 'dave@example.com' })
        const tampered = new URL(mailed[0]!)
        tampered.searchParams.set('redirect', '//evil.example')
        const signin = await submitConfirmForm(app, tampered.href, await readConfirmForm(await app.get(tampered.pathname + tampered.search)))
        expect(signin.status).toBe(303)
        expect(signin.headers.get('location')).toBe('/')
      }
      finally {
        auth.dispose()
      }
    })

    test('POST /auth/signup refuses to mail verification link on foreign Host when `site` is unset', async () => {
      const appDir = makeMinimalApp('box11-foreign-host')
      const mailed: string[] = []
      const auth = createAuth({
        secret: 'audit-box11-host-secret-32-bytes-min!',
        sendMail: (m) => { mailed.push(m.url) },
      })
      try {
        const app = await testApp({ root: appDir, plugins: [auth] })
        const res = await app.post(
          'http://evil.example/auth/signup',
          { email: 'victim@example.com', password: 'password1234' },
          { origin: 'http://evil.example' },
        )
        expect(res.status).toBe(500)
        expect(mailed.length).toBe(0)
        expect(await auth.store.getUserByEmail('victim@example.com')).toBeUndefined()
      }
      finally {
        auth.dispose()
      }
    })

    test('requireEmailVerification: false explicitly opts in to immediate session on signup', async () => {
      const appDir = makeMinimalApp('box11-opt-out')
      const auth = createAuth({
        secret: 'audit-box11-optout-secret-32-bytes!!',
        requireEmailVerification: false,
      })
      try {
        const app = await testApp({ root: appDir, plugins: [auth] })
        const res = await app.post('/auth/signup', { email: 'optout@example.com', password: 'password1234' })
        expect(res.status).toBe(201)
        expect(app.cookies.has('kay_session')).toBe(true)
      }
      finally {
        auth.dispose()
      }
    })
  })

  describe('Box 12: Production refuses missing/short auth secret & app scaffold drops insecure defaults', () => {
    test('refuses empty secret in all environments and missing/short secret in production', () => {
      const prevEnv = process.env.NODE_ENV
      const prevSecret = process.env.AUTH_SECRET
      try {
        process.env.NODE_ENV = 'development'
        delete process.env.AUTH_SECRET
        expect(() => createAuth({ secret: '' })).toThrow(/secret/i)
        expect(() => createAuth({ secret: '   ' })).toThrow(/secret/i)

        process.env.NODE_ENV = 'production'
        delete process.env.AUTH_SECRET
        expect(() => createAuth()).toThrow(/secret/i)
        expect(() => createAuth({ secret: '' })).toThrow(/secret/i)
        expect(() => createAuth({ secret: 'a'.repeat(31) })).toThrow(/32/)

        const ok = createAuth({ secret: 'a'.repeat(32) })
        ok.dispose()

        process.env.AUTH_SECRET = 'short-env-secret'
        expect(() => createAuth()).toThrow(/32/)

        process.env.AUTH_SECRET = 'b'.repeat(32)
        const okEnv = createAuth()
        okEnv.dispose()
      }
      finally {
        if (prevEnv === undefined)
          delete process.env.NODE_ENV
        else
          process.env.NODE_ENV = prevEnv
        if (prevSecret === undefined)
          delete process.env.AUTH_SECRET
        else
          process.env.AUTH_SECRET = prevSecret
      }
    })

    test('app scaffold drops fallback secret and :memory: store and includes .env.example', () => {
      const dir = join(TMP, 'scaffold-app')
      const result = scaffoldProject(dir, { template: 'app' })
      const authTs = readFileSync(join(dir, 'src', 'auth.ts'), 'utf8')
      expect(authTs).not.toContain('dev-secret-change-in-production')
      expect(authTs).not.toContain(':memory:')
      expect(authTs).toContain('AUTH_SECRET')
      expect(authTs).toContain('auth.sqlite')
      expect(result.files).toContain('.env.example')
      const envExample = readFileSync(join(dir, '.env.example'), 'utf8')
      expect(envExample).toContain('AUTH_SECRET=')
    })
  })

  describe('Box 13: Auth rate limit keys on real client IP + email, covers verify & OAuth, evicts expired keys', () => {
    test('ignores spoofed X-Forwarded-For by default and prefers ctx.ip when populated by server', async () => {
      const appDir = makeMinimalApp('box13-ip-spoof')
      const auth = createAuth({
        secret: 'audit-box13-secret-32-bytes-minimum!!',
        rateLimit: { max: 2, windowMs: 60_000 },
      })
      try {
        const app = await testApp({ root: appDir, plugins: [auth] })
        // Different spoofed X-Forwarded-For headers must NOT bypass rate limiting when trustProxy is false
        const r1 = await app.post('/auth/signin', { email: 'a1@example.com', password: 'x' }, { 'x-forwarded-for': '1.1.1.1' })
        const r2 = await app.post('/auth/signin', { email: 'a2@example.com', password: 'x' }, { 'x-forwarded-for': '2.2.2.2' })
        const r3 = await app.post('/auth/signin', { email: 'a3@example.com', password: 'x' }, { 'x-forwarded-for': '3.3.3.3' })
        expect(r1.status).toBe(401)
        expect(r2.status).toBe(401)
        expect(r3.status).toBe(429)
        expect(r3.headers.get('retry-after')).toBe('60')
      }
      finally {
        auth.dispose()
      }

      // When Kay server populates ctx.ip, plugin-auth uses ctx.ip and ignores spoofed X-Forwarded-For even if trustProxy is true
      let currentIp = '203.0.113.10'
      const authCtxIp = createAuth({
        secret: 'audit-box13-ctxip-secret-32-bytes-min!',
        trustProxy: true,
        rateLimit: { max: 1, windowMs: 60_000 },
      })
      try {
        const injectIpPlugin = {
          name: 'test-inject-ip',
          server(api: { use: (mw: (ctx: Record<string, unknown>, next: () => Promise<Response>) => Promise<Response>) => void }) {
            api.use(async (ctx, next) => {
              ctx.ip = currentIp
              return next()
            })
          },
        }
        const app2 = await testApp({ root: appDir, plugins: [injectIpPlugin as never, authCtxIp] })
        const a1 = await app2.post('/auth/signin', { email: 'p1@example.com', password: 'x' }, { 'x-forwarded-for': '198.51.100.1' })
        const a2 = await app2.post('/auth/signin', { email: 'p2@example.com', password: 'x' }, { 'x-forwarded-for': '198.51.100.2' })
        expect(a1.status).toBe(401)
        expect(a2.status).toBe(429) // Same ctx.ip despite different X-Forwarded-For!

        currentIp = '203.0.113.11'
        const a3 = await app2.post('/auth/signin', { email: 'p3@example.com', password: 'x' }, { 'x-forwarded-for': '198.51.100.1' })
        expect(a3.status).toBe(401) // New ctx.ip gets its own bucket!
      }
      finally {
        authCtxIp.dispose()
      }
    })

    test('rate-limits by normalized email across distinct client IPs (trustProxy: true)', async () => {
      const appDir = makeMinimalApp('box13-email-bucket')
      const auth = createAuth({
        secret: 'audit-box13-email-secret-32-bytes-min!',
        trustProxy: true,
        rateLimit: { max: 2, windowMs: 60_000 },
      })
      try {
        const app = await testApp({ root: appDir, trustProxy: true, plugins: [auth] })

        // Sign-in: distinct IPs, same email (different casing) -> blocked on 3rd attempt
        const s1 = await app.post('/auth/signin', { email: 'Target@Example.com', password: 'bad' }, { 'x-forwarded-for': '10.0.0.1' })
        const s2 = await app.post('/auth/signin', { email: 'target@example.com', password: 'bad' }, { 'x-forwarded-for': '10.0.0.2' })
        const s3 = await app.post('/auth/signin', { email: ' TARGET@EXAMPLE.COM ', password: 'bad' }, { 'x-forwarded-for': '10.0.0.3' })
        expect(s1.status).toBe(401)
        expect(s2.status).toBe(401)
        expect(s3.status).toBe(429)

        // Magic-link: distinct IPs, same email -> blocked on 3rd attempt
        const m1 = await app.post('/auth/magic-link', { email: 'Flood@Example.com' }, { 'x-forwarded-for': '10.1.0.1' })
        const m2 = await app.post('/auth/magic-link', { email: 'flood@example.com' }, { 'x-forwarded-for': '10.1.0.2' })
        const m3 = await app.post('/auth/magic-link', { email: 'flood@example.com' }, { 'x-forwarded-for': '10.1.0.3' })
        expect(m1.status).toBe(200)
        expect(m2.status).toBe(200)
        expect(m3.status).toBe(429)

        // Sign-up: distinct IPs, same email -> blocked on 3rd attempt
        const u1 = await app.post('/auth/signup', { email: 'Dup@Example.com', password: 'short' }, { 'x-forwarded-for': '10.2.0.1' })
        const u2 = await app.post('/auth/signup', { email: 'dup@example.com', password: 'short' }, { 'x-forwarded-for': '10.2.0.2' })
        const u3 = await app.post('/auth/signup', { email: 'dup@example.com', password: 'short' }, { 'x-forwarded-for': '10.2.0.3' })
        expect(u1.status).toBe(400)
        expect(u2.status).toBe(400)
        expect(u3.status).toBe(429)

        // Reverse-proxy Origin verification works when trustProxy: true
        const proxied = await app.post('/auth/signup', { email: 'proxied@example.com', password: 'password1234' }, {
          'origin': 'https://app.example',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'app.example',
          'x-forwarded-for': '10.3.0.1',
        })
        expect(proxied.status).toBe(202)
      }
      finally {
        auth.dispose()
      }
    })

    test('rate-limits /magic-link/verify, /verify-email, and OAuth start & callback endpoints', async () => {
      const appDir = makeMinimalApp('box13-verify-oauth')
      const auth = createAuth({
        secret: 'audit-box13-verify-secret-32-bytes-min',
        rateLimit: { max: 2, windowMs: 60_000 },
        providers: [
          oauthProvider({
            id: 'mock',
            clientId: 'cid',
            clientSecret: 'csec',
            authorizeUrl: 'https://provider.example/authorize',
            tokenUrl: 'https://provider.example/token',
            scopes: ['email'],
            fetchProfile: async () => ({ id: '1', email: 'a@b.c', emailVerified: true }),
          }),
        ],
      })
      try {
        const app = await testApp({ root: appDir, plugins: [auth] })

        // /magic-link/verify
        expect((await app.get('/auth/magic-link/verify?token=bad1')).status).toBe(200)
        expect((await app.post('/auth/magic-link/verify', { token: 'bad2' })).status).toBe(400)
        expect((await app.get('/auth/magic-link/verify?token=bad3')).status).toBe(429)

        // /verify-email (GET & POST share bucket)
        expect((await app.get('/auth/verify-email?token=bad1')).status).toBe(200)
        expect((await app.post('/auth/verify-email', { token: 'bad2' })).status).toBe(400)
        expect((await app.get('/auth/verify-email?token=bad3')).status).toBe(429)

        // /oauth/:provider
        expect((await app.get('/auth/oauth/mock')).status).toBe(302)
        expect((await app.get('/auth/oauth/mock')).status).toBe(302)
        expect((await app.get('/auth/oauth/mock')).status).toBe(429)

        // /oauth/:provider/callback
        expect((await app.get('/auth/oauth/mock/callback?code=a&state=b')).status).toBe(400)
        expect((await app.get('/auth/oauth/mock/callback?code=a&state=b')).status).toBe(400)
        expect((await app.get('/auth/oauth/mock/callback?code=a&state=b')).status).toBe(429)
      }
      finally {
        auth.dispose()
      }
    })

    test('evicts expired keys and caps map size so rate limiter never grows unboundedly', async () => {
      const limiter = createRateLimiter({ max: 5, windowMs: 30, maxKeys: 10 })
      for (let i = 0; i < 25; i++)
        expect(limiter.allow(`k-${i}`)).toBe(true)
      expect(limiter.size()).toBeLessThanOrEqual(10)

      // Wait for window to expire and sweep
      await Bun.sleep(45)
      limiter.sweep()
      expect(limiter.size()).toBe(0)
    })
  })

  describe('Box 19: RGPD — periodic prune timer, AuthStore deleteUser/exportUser/listSessions, and IP minimization', () => {
    for (const [label, createStore] of [
      ['memoryAuthStore', () => memoryAuthStore()] as const,
      ['sqliteAuthStore', () => sqliteAuthStore(':memory:')] as const,
    ]) {
      test(`${label}: listSessions, exportUser, deleteUser cascade, and pruneExpired`, async () => {
        const store: AuthStore = createStore()
        const now = Date.now()
        await store.createUser({
          id: 'u1',
          email: 'rgpd@example.com',
          name: 'RGPD User',
          role: 'user',
          emailVerified: true,
          passwordHash: 'secret-argon2-hash',
          createdAt: now,
          updatedAt: now,
        })
        await store.createSession({ id: 'sess-active-1', userId: 'u1', createdAt: now - 1000, expiresAt: now + 60_000, ip: '203.0.113.0', userAgent: 'UA1' })
        await store.createSession({ id: 'sess-active-2', userId: 'u1', createdAt: now, expiresAt: now + 60_000, ip: '203.0.113.0', userAgent: 'UA2' })
        await store.createSession({ id: 'sess-expired', userId: 'u1', createdAt: now - 5000, expiresAt: now - 1000 })
        await store.linkOAuthAccount({ provider: 'github', providerAccountId: 'gh-1', userId: 'u1', createdAt: now })
        await store.createToken({ tokenHash: 'tok-user', userId: 'u1', email: 'rgpd@example.com', kind: 'verify-email', expiresAt: now + 60_000 })
        await store.createToken({ tokenHash: 'tok-email-only', email: 'rgpd@example.com', kind: 'magic-link', expiresAt: now + 60_000 })
        await store.createToken({ tokenHash: 'tok-expired', email: 'other@example.com', kind: 'magic-link', expiresAt: now - 1000 })

        // listSessions returns only active non-expired sessions
        const sessions = await store.listSessions('u1')
        expect(sessions.map(s => s.id).sort()).toEqual(['sess-active-1', 'sess-active-2'])

        // exportUser returns profile without passwordHash, active sessions, and OAuth accounts
        const exported = await store.exportUser('u1')
        expect(exported).not.toBeNull()
        expect(exported!.user.email).toBe('rgpd@example.com')
        expect((exported!.user as Record<string, unknown>).passwordHash).toBeUndefined()
        expect(exported!.sessions.length).toBe(2)
        expect(exported!.oauthAccounts).toEqual([{ provider: 'github', providerAccountId: 'gh-1', createdAt: now }])
        expect(typeof exported!.exportedAt).toBe('number')
        expect(await store.exportUser('missing-user')).toBeNull()

        // pruneExpired purges expired sessions and tokens while keeping active ones
        await store.pruneExpired()
        expect(await store.getSession('sess-expired')).toBeUndefined()
        expect(await store.getSession('sess-active-1')).toBeDefined()
        expect(await store.consumeToken('tok-expired', 'magic-link')).toBeUndefined()

        // deleteUser cascades user, sessions, OAuth accounts, and tokens
        await store.deleteUser('u1')
        expect(await store.getUserById('u1')).toBeUndefined()
        expect(await store.getUserByEmail('rgpd@example.com')).toBeUndefined()
        expect(await store.listSessions('u1')).toEqual([])
        expect(await store.getSession('sess-active-1')).toBeUndefined()
        expect(await store.getOAuthAccount('github', 'gh-1')).toBeUndefined()
        expect(await store.consumeToken('tok-user', 'verify-email')).toBeUndefined()
        expect(await store.consumeToken('tok-email-only', 'magic-link')).toBeUndefined()
      })
    }

    test('the prune timer runs per server, so a server sharing the plugin keeps pruning after another one shuts down', async () => {
      const store = sqliteAuthStore(':memory:')
      const auth = createAuth({
        store,
        secret: 'audit-box19-timer-secret-32-bytes-min!',
        pruneIntervalMs: 25,
      })
      const appDir = makeMinimalApp('box19-timer')
      const first = await testApp({ root: appDir, plugins: [auth] })
      const second = await testApp({ root: appDir, prebuilt: true, plugins: [auth] })
      await first.app.dispose?.()
      const count = (table: string): number => store.db.query<{ c: number }, []>(`SELECT COUNT(*) as c FROM ${table}`).get()!.c
      try {
        const now = Date.now()
        await store.createUser({ id: 'u-prune', email: 'prune@example.com', role: 'user', emailVerified: true, createdAt: now, updatedAt: now })
        await store.createSession({ id: 'exp-sess', userId: 'u-prune', createdAt: now - 5000, expiresAt: now - 10 })
        await store.createToken({ tokenHash: 'exp-tok', userId: 'u-prune', email: 'prune@example.com', kind: 'magic-link', expiresAt: now - 10 })
        const deadline = Date.now() + 2000
        while (count('kay_auth_sessions') + count('kay_auth_tokens') > 0 && Date.now() < deadline)
          await Bun.sleep(10)
        expect(count('kay_auth_sessions')).toBe(0)
        expect(count('kay_auth_tokens')).toBe(0)
      }
      finally {
        await second.app.dispose?.()
        store.db.close()
      }
    })

    test('storeIp defaults to truncate (RGPD Art. 25.2), supports true/false, storeUserAgent (false), and default minPasswordLength is 12 (CNIL)', async () => {
      const appDir = makeMinimalApp('box19-pii')
      const authDefault = createAuth({
        secret: 'audit-box19-pii-secret-32-bytes-min!!',
        trustProxy: true,
        storeUserAgent: false,
        requireEmailVerification: false,
      })
      const authFullIp = createAuth({
        secret: 'audit-box19-pii-secret-32-bytes-min!!',
        trustProxy: true,
        storeIp: true,
        requireEmailVerification: false,
      })
      const authNone = createAuth({
        secret: 'audit-box19-pii-secret-32-bytes-min!!',
        trustProxy: true,
        storeIp: false,
        requireEmailVerification: false,
      })
      try {
        const app1 = await testApp({ root: appDir, plugins: [authDefault] })

        // Default CNIL minPasswordLength: 11 chars rejected, 12 chars accepted
        const shortPw = await app1.post('/auth/signup', { email: 'short@example.com', password: '11chars-pw!' }, {
          'x-forwarded-for': '203.0.113.42',
        })
        expect(shortPw.status).toBe(400)

        const okV4 = await app1.post('/auth/signup', { email: 'v4@example.com', password: 'password1234' }, {
          'x-forwarded-for': '203.0.113.42',
          'user-agent': 'SecretBrowser/1.0',
        })
        expect(okV4.status).toBe(201)
        const u4 = (await authDefault.store.getUserByEmail('v4@example.com'))!
        const s4 = await authDefault.listSessions(u4.id)
        expect(s4.length).toBe(1)
        expect(s4[0]!.ip).toBe('203.0.113.0')
        expect(s4[0]!.userAgent).toBeUndefined()

        app1.clearCookies()
        await app1.post('/auth/signup', { email: 'v6@example.com', password: 'password1234' }, {
          'x-forwarded-for': '2001:db8:85a3:0:0:8a2e:370:7334',
        })
        const u6 = (await authDefault.store.getUserByEmail('v6@example.com'))!
        const s6 = await authDefault.listSessions(u6.id)
        expect(s6[0]!.ip).toBe('2001:db8:85a3::')

        const appFull = await testApp({ root: appDir, plugins: [authFullIp] })
        await appFull.post('/auth/signup', { email: 'fullip@example.com', password: 'password1234' }, {
          'x-forwarded-for': '203.0.113.42',
        })
        const uFull = (await authFullIp.store.getUserByEmail('fullip@example.com'))!
        const sFull = await authFullIp.listSessions(uFull.id)
        expect(sFull[0]!.ip).toBe('203.0.113.42')

        const app2 = await testApp({ root: appDir, plugins: [authNone] })
        await app2.post('/auth/signup', { email: 'noip@example.com', password: 'password1234' }, {
          'x-forwarded-for': '203.0.113.42',
        })
        const uNone = (await authNone.store.getUserByEmail('noip@example.com'))!
        const sNone = await authNone.listSessions(uNone.id)
        expect(sNone[0]!.ip).toBeUndefined()
      }
      finally {
        authDefault.dispose()
        authFullIp.dispose()
        authNone.dispose()
      }
    })
  })

  describe('Issue #3634: async AuthStore locals, session/OAuth/signup hardening, SQLite lifecycle, and rate limiter', () => {
    test('1. async AuthStore populates ctx.locals.user and ctx.locals.session on pages and actions', async () => {
      const appDir = join(TMP, 'issue3634-async-store')
      const routesDir = join(appDir, 'src', 'routes')
      mkdirSync(routesDir, { recursive: true })
      writeFileSync(join(routesDir, 'index.tsx'), `
        import type { PageProps } from '@kayjs/kay'
        import { action } from '@kayjs/kay/server'

        export const whoami = action(async (ctx) => ({
          email: ctx.locals.user?.email ?? null,
          hasSession: Boolean(ctx.locals.session?.id),
        }))

        export default function Page({ locals }: PageProps) {
          return <main>{locals.user?.email ?? 'anon'}|{locals.session?.id ? 'sess' : 'nosess'}</main>
        }
      `)

      const base = memoryAuthStore()
      let getSessionCalls = 0
      const asyncStore: AuthStore = {
        async getUserById(id) {
          await Promise.resolve()
          return base.getUserById(id)
        },
        async getUserByEmail(email) {
          await Promise.resolve()
          return base.getUserByEmail(email)
        },
        async createUser(u) {
          await Promise.resolve()
          return base.createUser(u)
        },
        async updateUser(id, patch) {
          await Promise.resolve()
          return base.updateUser(id, patch)
        },
        async deleteUser(id) {
          await Promise.resolve()
          return base.deleteUser(id)
        },
        async exportUser(id) {
          await Promise.resolve()
          return base.exportUser(id)
        },
        async getSession(hash) {
          getSessionCalls++
          await Promise.resolve()
          return base.getSession(hash)
        },
        async listSessions(uid) {
          await Promise.resolve()
          return base.listSessions(uid)
        },
        async createSession(s) {
          await Promise.resolve()
          return base.createSession(s)
        },
        async updateSessionExpiry(h, exp) {
          await Promise.resolve()
          return base.updateSessionExpiry(h, exp)
        },
        async deleteSession(h) {
          await Promise.resolve()
          return base.deleteSession(h)
        },
        async deleteUserSessions(uid) {
          await Promise.resolve()
          return base.deleteUserSessions(uid)
        },
        async getOAuthAccount(p, id) {
          await Promise.resolve()
          return base.getOAuthAccount(p, id)
        },
        async linkOAuthAccount(a) {
          await Promise.resolve()
          return base.linkOAuthAccount(a)
        },
        async deleteUserOAuthAccounts(uid) {
          await Promise.resolve()
          return base.deleteUserOAuthAccounts(uid)
        },
        async createToken(t) {
          await Promise.resolve()
          return base.createToken(t)
        },
        async consumeToken(h, k) {
          await Promise.resolve()
          return base.consumeToken(h, k)
        },
        async pruneExpired() {
          await Promise.resolve()
          return base.pruneExpired()
        },
      }

      const auth = createAuth({
        store: asyncStore,
        secret: 'issue3634-async-store-secret-32bytes!',
        requireEmailVerification: false,
      })
      try {
        const app = await testApp({ root: appDir, plugins: [auth] })

        // Unauthenticated visitor triggers zero getSession lookups
        const guest = await app.get('/')
        expect(guest.status).toBe(200)
        expect(await guest.text()).toContain('anon|nosess')
        expect(getSessionCalls).toBe(0)

        // Signed-in user sees ctx.locals.user and ctx.locals.session on SSR page & server action
        const signup = await app.post('/auth/signup', { email: 'async@example.com', password: 'strong-password-123' })
        expect(signup.status).toBe(201)

        const pageRes = await app.get('/')
        expect(pageRes.status).toBe(200)
        expect(await pageRes.text()).toContain('async@example.com|sess')

        const actionUrl = app.manifest!.actions.find(a => a.exportName === 'whoami')!.url
        const actionRes = await app.post(actionUrl, {})
        expect(actionRes.status).toBe(200)
        expect(await actionRes.json()).toEqual({ ok: true, data: { email: 'async@example.com', hasSession: true } })
      }
      finally {
        auth.dispose()
      }

      // Also works for a non-async function store returning Promises
      const base2 = memoryAuthStore()
      const promiseStore: AuthStore = {
        ...base2,
        createSession: s => Promise.resolve(base2.createSession(s)),
        getSession: h => Promise.resolve(base2.getSession(h)),
        getUserById: id => Promise.resolve(base2.getUserById(id)),
      }
      const auth2 = createAuth({
        store: promiseStore,
        secret: 'issue3634-promise-store-secret-32byt!',
        requireEmailVerification: false,
      })
      try {
        const app2 = await testApp({ root: appDir, prebuilt: true, plugins: [auth2] })
        expect((await app2.post('/auth/signup', { email: 'prom@example.com', password: 'strong-password-123' })).status).toBe(201)
        const page2 = await app2.get('/')
        expect(await page2.text()).toContain('prom@example.com|sess')
      }
      finally {
        auth2.dispose()
      }
    })

    test('2. revokes previous session on sign-in and sets Cache-Control: no-store on all auth endpoints', async () => {
      const appDir = makeMinimalApp('issue3634-session-nostore')
      const mailed: string[] = []
      const auth = createAuth({
        secret: 'issue3634-nostore-secret-32-bytes-ok!',
        requireEmailVerification: false,
        sendMail: (m) => { mailed.push(m.url) },
        providers: [
          oauthProvider({
            id: 'mock',
            clientId: 'cid',
            clientSecret: 'csec',
            authorizeUrl: 'https://provider.example/authorize',
            tokenUrl: 'https://provider.example/token',
            scopes: ['email'],
            fetchProfile: async () => ({ id: '1', email: 'o@example.com', emailVerified: true }),
          }),
        ],
      })
      try {
        const app = await testApp({ root: appDir, plugins: [auth] })

        // Create two users
        const sA = await app.post('/auth/signup', { email: 'user-a@example.com', password: 'password-alpha-123' })
        expect(sA.status).toBe(201)
        expect(sA.headers.get('cache-control')).toBe('no-store')
        const cookieA = app.cookies.get('kay_session')!
        const userA = (await auth.store.getUserByEmail('user-a@example.com'))!

        app.clearCookies()
        const sB = await app.post('/auth/signup', { email: 'user-b@example.com', password: 'password-bravo-123' })
        expect(sB.status).toBe(201)
        app.clearCookies()

        // Shared browser holds User A's cookie, then User B signs in
        app.cookies.set('kay_session', cookieA)
        const signInB = await app.post('/auth/signin', { email: 'user-b@example.com', password: 'password-bravo-123' })
        expect(signInB.status).toBe(200)
        expect(signInB.headers.get('cache-control')).toBe('no-store')
        const cookieB = app.cookies.get('kay_session')!
        expect(cookieB).not.toBe(cookieA)

        // Cookie B belongs to User B
        const sessB = await app.get('/auth/session')
        expect(sessB.headers.get('cache-control')).toBe('no-store')
        expect(((await sessB.json()) as { user: { email: string } }).user.email).toBe('user-b@example.com')

        // Cookie A was revoked in the store!
        expect(await auth.listSessions(userA.id)).toEqual([])
        app.clearCookies()
        app.cookies.set('kay_session', cookieA)
        const sessA = await app.get('/auth/session')
        expect(sessA.headers.get('cache-control')).toBe('no-store')
        expect(((await sessA.json()) as { user: unknown }).user).toBeNull()

        // Cache-Control: no-store on verify-email, magic-link, signout, and OAuth routes
        const verifyBad = await app.get('/auth/verify-email?token=bad')
        expect(verifyBad.headers.get('cache-control')).toBe('no-store')

        const verifyPostBad = await app.post('/auth/verify-email', { token: 'bad' })
        expect(verifyPostBad.headers.get('cache-control')).toBe('no-store')

        const mlReq = await app.post('/auth/magic-link', { email: 'user-a@example.com' })
        expect(mlReq.status).toBe(200)
        expect(mlReq.headers.get('cache-control')).toBe('no-store')
        const mlUrl = new URL(mailed[0]!)
        const mlVerify = await app.get(mlUrl.pathname + mlUrl.search)
        expect(mlVerify.status).toBe(200)
        expect(mlVerify.headers.get('cache-control')).toBe('no-store')
        const mlPost = await app.post('/auth/magic-link/verify', { token: mlUrl.searchParams.get('token') })
        expect(mlPost.status).toBe(200)
        expect(mlPost.headers.get('cache-control')).toBe('no-store')

        const signout = await app.post('/auth/signout', {})
        expect(signout.headers.get('cache-control')).toBe('no-store')

        const oauthStart = await app.get('/auth/oauth/mock')
        expect(oauthStart.status).toBe(302)
        expect(oauthStart.headers.get('cache-control')).toBe('no-store')

        const oauthCb = await app.get('/auth/oauth/mock/callback?code=x&state=y')
        expect(oauthCb.status).toBe(400)
        expect(oauthCb.headers.get('cache-control')).toBe('no-store')
      }
      finally {
        auth.dispose()
      }
    })

    test('3. GitHub OAuth queries /user/emails even when user.email is public and OAuth HTTP calls handle timeouts & malformed responses', async () => {
      // Unit test GitHub/Discord/Google fetchProfile with mocked fetch
      const origFetch = globalThis.fetch
      const calls: Array<{ url: string, hasSignal: boolean }> = []
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        calls.push({ url, hasSignal: init?.signal instanceof AbortSignal })
        if (url === 'https://api.github.com/user')
          return Response.json({ id: 77, email: 'pub@example.com', name: 'Octo', login: 'octo', avatar_url: 'https://a.test/i.png' })
        if (url === 'https://api.github.com/user/emails')
          return Response.json([{ email: 'pub@example.com', primary: true, verified: true }])
        if (url === 'https://discord.com/api/users/@me')
          return Response.json({ id: 'd1', email: 'd@example.com', verified: true, username: 'disc' })
        if (url === 'https://openidconnect.googleapis.com/v1/userinfo')
          return Response.json({ sub: 'g1', email: 'g@example.com', email_verified: true, name: 'Goog' })
        return origFetch(input, init)
      }) as typeof fetch

      try {
        const ghProfile = await github({ clientId: 'c', clientSecret: 's' }).fetchProfile('tok')
        expect(ghProfile.email).toBe('pub@example.com')
        expect(ghProfile.emailVerified).toBe(true)
        expect(calls.map(c => c.url)).toEqual([
          'https://api.github.com/user',
          'https://api.github.com/user/emails',
        ])

        await discord({ clientId: 'c', clientSecret: 's' }).fetchProfile('tok')
        await google({ clientId: 'c', clientSecret: 's' }).fetchProfile('tok')
        expect(calls.every(c => c.hasSignal)).toBe(true)
      }
      finally {
        globalThis.fetch = origFetch
      }

      // OAuth callback gracefully returns 502 on invalid JSON token response or fetchProfile failure
      const appDir = makeMinimalApp('issue3634-oauth-hardening')
      let tokenMode: 'bad-json' | 'ok' = 'bad-json'
      const mockTokenServer = Bun.serve({
        port: 0,
        fetch() {
          if (tokenMode === 'bad-json')
            return new Response('<html>bad gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } })
          return Response.json({ access_token: 'tok-ok' })
        },
      })
      const auth = createAuth({
        secret: 'issue3634-oauth-secret-32-bytes-min!!',
        providers: [
          oauthProvider({
            id: 'broken',
            clientId: 'cid',
            clientSecret: 'csec',
            authorizeUrl: 'https://provider.example/authorize',
            tokenUrl: `http://127.0.0.1:${mockTokenServer.port}/token`,
            scopes: ['email'],
            async fetchProfile() {
              throw new Error('upstream profile 503')
            },
          }),
        ],
      })
      try {
        const app = await testApp({ root: appDir, plugins: [auth] })

        // Bad JSON from token endpoint -> 502 (not unhandled 500)
        const s1 = await app.get('/auth/oauth/broken')
        const state1 = new URL(s1.headers.get('location')!).searchParams.get('state')!
        const cb1 = await app.get(`/auth/oauth/broken/callback?code=abc&state=${state1}`)
        expect(cb1.status).toBe(502)
        expect(cb1.headers.get('cache-control')).toBe('no-store')

        // fetchProfile throws -> 502 (not unhandled 500)
        tokenMode = 'ok'
        const s2 = await app.get('/auth/oauth/broken')
        const state2 = new URL(s2.headers.get('location')!).searchParams.get('state')!
        const cb2 = await app.get(`/auth/oauth/broken/callback?code=abc&state=${state2}`)
        expect(cb2.status).toBe(502)
        expect(cb2.headers.get('cache-control')).toBe('no-store')

        // Same-length tampered state rejected with 400
        const s3 = await app.get('/auth/oauth/broken')
        const state3 = new URL(s3.headers.get('location')!).searchParams.get('state')!
        const forged = `${state3[0] === 'a' ? 'b' : 'a'}${state3.slice(1)}`
        const cb3 = await app.get(`/auth/oauth/broken/callback?code=abc&state=${forged}`)
        expect(cb3.status).toBe(400)
      }
      finally {
        mockTokenServer.stop(true)
        auth.dispose()
      }
    })

    test('4. /signup rolls back on mail delivery failure and avoids email enumeration when verification is required', async () => {
      const appDir = makeMinimalApp('issue3634-signup-rollback')
      let failMail = true
      const mailed: Array<{ to: string, url: string }> = []
      const auth = createAuth({
        secret: 'issue3634-signup-secret-32-bytes-min!',
        sendMail: async (m) => {
          if (failMail)
            throw new Error('SMTP down')
          mailed.push({ to: m.to, url: m.url })
        },
      })
      try {
        const app = await testApp({ root: appDir, plugins: [auth] })

        // Mail outage during signup returns 500 and rolls back the unverified user
        const failed = await app.post('/auth/signup', { email: 'retry@example.com', password: 'strong-password-123' })
        expect(failed.status).toBe(500)
        expect(await auth.store.getUserByEmail('retry@example.com')).toBeUndefined()

        // Once mail recovers, the same email can sign up without lockout
        failMail = false
        const ok1 = await app.post('/auth/signup', { email: 'retry@example.com', password: 'strong-password-123' })
        expect(ok1.status).toBe(202)
        const body1 = await ok1.json() as { ok: boolean, verificationRequired: boolean, user?: unknown }
        expect(body1.ok).toBe(true)
        expect(body1.verificationRequired).toBe(true)
        expect(body1.user).toBeUndefined()
        expect(mailed.length).toBe(1)

        // Signing up again while unverified re-issues a fresh verification link with identical 202 response
        const okResend = await app.post('/auth/signup', { email: 'retry@example.com', password: 'strong-password-123' })
        expect(okResend.status).toBe(202)
        expect(await okResend.json()).toEqual(body1)
        expect(mailed.length).toBe(2)

        // Verify email using the re-issued link
        const verifyRes = await submitConfirmForm(app, mailed[1]!.url, await readConfirmForm(await app.get(new URL(mailed[1]!.url).pathname + new URL(mailed[1]!.url).search)))
        expect(verifyRes.status).toBe(303)
        app.clearCookies()

        // Signing up again for an already-verified email returns the identical 202 response (no 409 enumeration) and sends no mail
        const existingRes = await app.post('/auth/signup', { email: 'retry@example.com', password: 'other-password-999' })
        expect(existingRes.status).toBe(202)
        expect(await existingRes.json()).toEqual(body1)
        expect(mailed.length).toBe(2)
      }
      finally {
        auth.dispose()
      }
    })

    test('5. sqliteAuthStore sets busy_timeout = 5000 and closes owned DB handle on server shutdown', async () => {
      const appDir = makeMinimalApp('issue3634-sqlite-lifecycle')
      const dbPath = join(TMP, 'issue3634-lifecycle.sqlite')
      const store = sqliteAuthStore(dbPath)
      const busy = store.db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()
      expect(busy?.timeout).toBe(5000)

      const auth = createAuth({
        store,
        secret: 'issue3634-sqlite-secret-32-bytes-min!',
      })
      const app = await testApp({ root: appDir, plugins: [auth] })
      await app.app.dispose?.()

      // Owned DB handle is closed after shutdown
      expect(() => store.db.query('SELECT 1').get()).toThrow()

      // Externally supplied Database handle is NOT closed on shutdown
      const externalDb = new Database(':memory:')
      const externalStore = sqliteAuthStore(externalDb)
      const authExt = createAuth({
        store: externalStore,
        secret: 'issue3634-extdb-secret-32-bytes-min!!',
      })
      const appExt = await testApp({ root: appDir, prebuilt: true, plugins: [authExt] })
      await appExt.app.dispose?.()
      expect(externalDb.query<{ n: number }, []>('SELECT 1 as n').get()?.n).toBe(1)
      externalDb.close()
    })

    test('6. prune timer sweeps renewedAt and rate limiter stays O(1) at maxKeys capacity', async () => {
      // Rate limiter O(1) eviction at maxKeys=10_000 under flood of distinct keys
      const limiter = createRateLimiter({ max: 5, windowMs: 60_000, maxKeys: 10_000 })
      for (let i = 0; i < 10_000; i++)
        limiter.allow(`seed-${i}`)
      expect(limiter.size()).toBe(10_000)

      const start = performance.now()
      for (let i = 0; i < 5_000; i++)
        expect(limiter.allow(`flood-${i}`)).toBe(true)
      const elapsedMs = performance.now() - start
      expect(limiter.size()).toBe(10_000)
      expect(elapsedMs).toBeLessThan(500)

      // Prune timer runs sweepRenewedAt() alongside store.pruneExpired()
      const appDir = makeMinimalApp('issue3634-renewed-sweep')
      const base = memoryAuthStore()
      let renewCalls = 0
      const store: AuthStore = {
        ...base,
        getSession(hash) {
          const s = base.getSession(hash)
          if (s && !(s instanceof Promise))
            s.expiresAt = Date.now() + 10_000
          return s
        },
        updateSessionExpiry(hash, exp) {
          renewCalls++
          return base.updateSessionExpiry(hash, exp)
        },
      }
      const auth = createAuth({
        store,
        secret: 'issue3634-renew-sweep-secret-32bytes!',
        requireEmailVerification: false,
        sessionTtlSeconds: 120,
        renewalIntervalSeconds: 0,
        pruneIntervalMs: 20,
      })
      const app = await testApp({ root: appDir, plugins: [auth] })
      try {
        expect((await app.post('/auth/signup', { email: 'sweep@example.com', password: 'strong-password-123' })).status).toBe(201)
        await app.get('/auth/session')
        expect(renewCalls).toBe(1)
        await Bun.sleep(40)
        await app.get('/auth/session')
        expect(renewCalls).toBe(2)
      }
      finally {
        await app.app.dispose?.()
      }
    })
  })
})
