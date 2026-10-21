import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { totpCode, totpStep } from '../../../src/totp'
import { mails } from '../src/auth'

// Deep links survive the sign-in: wherever the visitor is sent on the way, the page they asked for is carried and reached at the end, at the root and under a base with trailing slashes, in English and in French.
const ROOT = join(import.meta.dir, '..')
const PAGES = join(ROOT, '..', '..', 'src', 'pages', 'routes')
const PASSWORD = 'correct horse battery'
// What a browser sends opening a page, which is what the guard redirects.
const NAVIGATE = { 'sec-fetch-mode': 'navigate' }
const HOSTILE = ['//evil.test', 'https://evil.test', '/\\evil.test', 'javascript:alert(1)']

type Site = Awaited<ReturnType<typeof testSite>>
type Page = Awaited<ReturnType<Site['visit']>>

// Where a redirect or a link lands is the same page with or without the slash before the query, which kay's trailing slash setting settles on the next hop.
const bare = (url: string | null | undefined) => url?.replace('/?', '?')
const text = (page: Page, selector: string) => page.find(selector)[0]?.text
const hidden = (page: Page, name = 'redirect') => page.find(`input[name="${name}"]`)[0]?.attributes.value
const lastLink = (kind: string) => new URL(mails.findLast(mail => mail.kind === kind)!.url!)

const mounts = [
  { name: 'at the root', options: {}, base: '', slash: '', tag: 'root' },
  { name: 'under a base with trailing slashes', options: { base: '/app', trailingSlash: 'always' as const }, base: '/app', slash: '/', tag: 'app' },
]

for (const { name, options, base, slash, tag } of mounts) {
  describe(`the page a visitor asked for, ${name}`, () => {
    let site: Site
    let forms: Record<string, Parameters<Site['submit']>[0]>

    beforeAll(async () => {
      site = await testSite({ root: ROOT, headers: NAVIGATE, ...options })
      // After the site loads, as the pages' modules are compiled with it.
      const [signIn, register, reset, twoFactor, verify, security] = await Promise.all(['sign-in', 'register', 'reset-password', 'two-factor', 'verify-email', 'account/security'].map(async page => import(join(PAGES, `${page}.kay`))))

      forms = { password: signIn.password, register: register.register, request: reset.request, reset: reset.reset, verifyTwoFactor: twoFactor.verify, verify: verify.verify, enable: security.enable, setUp: security.setUp }
    })
    afterAll(async () => {
      await site.close()
    })

    const form = (name: string) => forms[name] as never

    async function registered(email: string, redirect?: string) {
      const visitor = await testSite({ root: ROOT, headers: NAVIGATE, ...options })
      const page = await visitor.visit(`/auth/register${slash}${redirect === undefined ? '' : `?redirect=${encodeURIComponent(redirect)}`}`)
      const done = await visitor.submit(form('register'), { email, password: PASSWORD, redirect: hidden(page) }, { from: page })

      return { visitor, done }
    }

    test('the guard sends a visitor to the sign-in page of their language, carrying the page', async () => {
      const sentTo = async (path: string) => bare((await site.fetch(path, { redirect: 'manual' })).headers.get('location'))

      expect(await sentTo(`/members${slash}`)).toBe(`${base}/auth/sign-in?redirect=%2Fmembers${encodeURIComponent(slash)}`)
      expect(await sentTo(`/fr/members${slash}`)).toBe(`${base}/fr/auth/sign-in?redirect=%2Ffr%2Fmembers${encodeURIComponent(slash)}`)
      expect(await sentTo(`/fr/members${slash}?tab=2`)).toBe(`${base}/fr/auth/sign-in?redirect=%2Ffr%2Fmembers${encodeURIComponent(slash)}%3Ftab%3D2`)
    })

    test('the sign-in page of a language hands the page to its password form, which signs in to it', async () => {
      const { visitor } = await registered(`password-${tag}@example.com`)

      await visitor.fetch('/auth/sign-out', { method: 'POST', redirect: 'manual' })

      for (const prefix of ['', '/fr']) {
        const asked = `${prefix}/note${slash}`
        const fresh = await testSite({ root: ROOT, headers: NAVIGATE, ...options })
        const page = await fresh.visit(`${prefix}/auth/sign-in${slash}?redirect=${encodeURIComponent(asked)}`)

        expect(hidden(page)).toBe(asked)

        const landed = await fresh.submit(form('password'), { identifier: `password-${tag}@example.com`, password: PASSWORD, redirect: hidden(page) }, { from: page })

        expect(landed).toMatchObject({ url: `${base}${asked}`, status: 200 })
      }
    })

    test('a page that leaves the site leads home from the sign-in page', async () => {
      for (const hostile of HOSTILE) {
        const page = await site.visit(`/auth/sign-in${slash}?redirect=${encodeURIComponent(hostile)}`)

        expect(hidden(page)).toBe('/')
      }
    })

    test('an OAuth sign-in that fails goes back to the sign-in page with the page kept', async () => {
      const visitor = await testSite({ root: ROOT, headers: NAVIGATE, ...options })
      const left = await visitor.fetch(`/auth/discord?redirect=${encodeURIComponent(`/fr/note${slash}`)}`, { redirect: 'manual' })
      const state = new URL(left.headers.get('location')!).searchParams.get('state')
      const back = await visitor.fetch(`/auth/discord/callback?error=access_denied&state=${state}`, { redirect: 'manual' })

      expect(bare(back.headers.get('location'))).toBe(`${base}/auth/sign-in?error=cancelled&redirect=${encodeURIComponent(`/fr/note${slash}`)}`)
    })

    test('an OAuth sign-in that fails leaves no trace of a page that leaves the site, nor of one not asked for', async () => {
      const visitor = await testSite({ root: ROOT, headers: NAVIGATE, ...options })

      for (const hostile of [...HOSTILE, undefined]) {
        const left = await visitor.fetch(`/auth/discord${hostile === undefined ? '' : `?redirect=${encodeURIComponent(hostile)}`}`, { redirect: 'manual' })
        const state = new URL(left.headers.get('location')!).searchParams.get('state')
        const back = await visitor.fetch(`/auth/discord/callback?error=access_denied&state=${state}`, { redirect: 'manual' })

        expect(bare(back.headers.get('location'))).toBe(`${base}/auth/sign-in?error=cancelled`)
      }

      // A callback no flow is waiting for does not know the page.
      expect(bare((await visitor.fetch('/auth/discord/callback?error=access_denied&state=nope', { redirect: 'manual' })).headers.get('location'))).toBe(`${base}/auth/sign-in?error=oauth`)
    })

    test('the code page with no sign-in waiting links back to sign-in with the page kept', async () => {
      for (const prefix of ['', '/fr']) {
        const asked = `${prefix}/note${slash}`
        const page = await site.visit(`${prefix}/auth/two-factor${slash}?redirect=${encodeURIComponent(asked)}`)
        const link = page.find('a').find(candidate => candidate.attributes.href?.includes('/auth/sign-in'))

        expect(bare(link?.attributes.href)).toBe(`${base}${prefix}/auth/sign-in?redirect=${encodeURIComponent(asked)}`)
      }

      for (const hostile of HOSTILE) {
        const page = await site.visit(`/auth/two-factor${slash}?redirect=${encodeURIComponent(hostile)}`)

        expect(bare(page.find('a').find(candidate => candidate.attributes.href?.includes('/auth/sign-in'))?.attributes.href)).toBe(`${base}/auth/sign-in?redirect=%2F`)
      }
    })

    test('a sign-in with a second factor carries the page through the code page', async () => {
      const email = `second-${tag}@example.com`
      const { visitor } = await registered(email)
      const scan = await visitor.submit(form('setUp'), { password: PASSWORD }, { from: `/auth/account/security${slash}` })
      const secret = text(scan, '#kayjs-auth-key')!
      const uri = scan.find('input[name="uri"]')[0]!.attributes.value!

      await visitor.submit(form('enable'), { code: await totpCode(secret, totpStep()), uri }, { from: `/auth/account/security${slash}` })
      await visitor.fetch('/auth/sign-out', { method: 'POST', redirect: 'manual' })

      const asked = `/fr/note${slash}`
      const page = await visitor.visit(`/fr/auth/sign-in${slash}?redirect=${encodeURIComponent(asked)}`)
      const code = await visitor.submit(form('password'), { identifier: email, password: PASSWORD, redirect: hidden(page) }, { from: page })

      expect(bare(code.url)).toBe(`${base}/fr/auth/two-factor?redirect=${encodeURIComponent(asked)}`)
      expect(await visitor.submit(form('verifyTwoFactor'), { code: await totpCode(secret, totpStep() + 1) }, { from: code })).toMatchObject({ url: `${base}${asked}`, status: 200 })
    })

    test('registering from the page a visitor asked for, the verification mail brings them back to it', async () => {
      const asked = `/note${slash}`
      const { visitor, done } = await registered(`verify-${tag}@example.com`, asked)

      expect(done).toMatchObject({ url: `${base}${asked}` })

      const link = lastLink('verify-email')
      const opened = await visitor.visit(link.pathname + link.search)

      expect(await visitor.submit(form('verify'), { token: link.searchParams.get('token')! }, { from: opened })).toMatchObject({ url: `${base}${asked}`, status: 200 })
    })

    test('another browser verifying the address, given the password, is sent to sign in and then to the page', async () => {
      const asked = `/fr/note${slash}`
      const email = `elsewhere-${tag}@example.com`

      await registered(email, asked)

      const link = lastLink('verify-email')
      const elsewhere = await testSite({ root: ROOT, headers: NAVIGATE, ...options })
      const opened = await elsewhere.visit(link.pathname + link.search)
      const verified = await elsewhere.submit(form('verify'), { token: link.searchParams.get('token')!, password: PASSWORD }, { from: opened })

      expect(bare(verified.url)).toBe(`${base}/auth/sign-in?redirect=${encodeURIComponent(asked)}`)
      expect(await elsewhere.submit(form('password'), { identifier: email, password: PASSWORD, redirect: hidden(verified) }, { from: verified })).toMatchObject({ url: `${base}${asked}`, status: 200 })
    })

    test('a forgotten password asked for from the sign-in page resets to the page the visitor was after', async () => {
      const asked = `/note${slash}`
      const email = `forgot-${tag}@example.com`
      const { visitor } = await registered(email)

      await visitor.fetch('/auth/sign-out', { method: 'POST', redirect: 'manual' })

      const signIn = await visitor.visit(`/auth/sign-in${slash}?redirect=${encodeURIComponent(asked)}`)
      const forgot = signIn.find('a').find(candidate => candidate.attributes.href?.includes('/reset-password'))

      expect(bare(forgot?.attributes.href)).toBe(`${base}/auth/reset-password?redirect=${encodeURIComponent(asked)}`)

      const page = await visitor.visit(forgot!.attributes.href!.replace(base, ''))

      expect(hidden(page)).toBe(asked)
      await visitor.submit(form('request'), { email, redirect: hidden(page) }, { from: page })

      // Mailed off the response's path.
      while (!mails.some(mail => mail.kind === 'reset-password' && mail.to === email))
        await Bun.sleep(5)

      const link = new URL(mails.findLast(mail => mail.kind === 'reset-password' && mail.to === email)!.url!)
      const choose = await visitor.visit(link.pathname + link.search)

      expect(await visitor.submit(form('reset'), { token: link.searchParams.get('token')!, password: 'a brand new passphrase' }, { from: choose })).toMatchObject({ url: `${base}${asked}`, status: 200 })
    })
  })
}
