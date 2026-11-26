import type { AuthStore } from '../../plugin-auth/src/store'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuth, createRateLimiter, memoryAuthStore, oauthProvider } from '../../plugin-auth/src/index'
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
        expect(signupBody.user?.email).toBe('alice@example.com')
        expect(signupBody.user?.emailVerified).toBe(false)
        expect(signupBody.user?.passwordHash).toBeUndefined()
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

        // Visiting the verification link verifies email and opens a session
        const verifyUrl = new URL(mailed[0]!.url)
        const verifyRes = await app.get(verifyUrl.pathname + verifyUrl.search)
        expect(verifyRes.status).toBe(302)
        expect(verifyRes.headers.get('location')).toBe('/welcome')
        expect(app.cookies.has('kay_session')).toBe(true)

        const sessAfter = await (await app.get('/auth/session')).json() as { user: { email: string, emailVerified: boolean } }
        expect(sessAfter.user.email).toBe('alice@example.com')
        expect(sessAfter.user.emailVerified).toBe(true)

        // Replaying the verification token fails
        app.clearCookies()
        const replay = await app.get(verifyUrl.pathname + verifyUrl.search)
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
        expect((await app.get('/auth/magic-link/verify?token=bad1')).status).toBe(400)
        expect((await app.get('/auth/magic-link/verify?token=bad2')).status).toBe(400)
        expect((await app.get('/auth/magic-link/verify?token=bad3')).status).toBe(429)

        // /verify-email (GET & POST share bucket)
        expect((await app.get('/auth/verify-email?token=bad1')).status).toBe(400)
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
})
