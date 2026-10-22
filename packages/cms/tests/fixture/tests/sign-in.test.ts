import type { Action, Guard } from 'kay'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { cms } from '../../../src/extension'
import { passwordGuard, SESSION_COOKIE } from '../../../src/password'

const ROOT = join(import.meta.dir, '..')

// The fixture's kay.config.ts calls cms() as it loads, after this one, so the settings are given again once it has.
async function siteWith(guard: Guard | undefined, extra: Record<string, unknown> = {}) {
  const options = { guard, ...extra }
  const made = await testSite({ root: ROOT, extensions: [cms(options)] })

  cms(options)

  return made
}

const site = await siteWith(passwordGuard({ editor: 'pw-editor', admin: 'pw-admin' }), { roles: { editor: [], admin: ['publish', 'delete', 'upload', 'redirects'] } })

// The route files are imported by path, which the checker cannot follow into the linked package.
const SIGN_IN = '../../../src/routes/sign-in.kay'
const ACTIONS = '../../../src/routes/_actions.kay'
const { signIn } = await import(SIGN_IN) as { signIn: Action<{ password: string, redirect?: string | undefined }, unknown> }
const { signOut } = await import(ACTIONS) as { signOut: Action<Record<string, never>, unknown> }

test('an anonymous visitor on a screen is sent to the sign-in screen, with the page asked for kept, query included', async () => {
  for (const path of ['/admin', '/admin/collections/posts?q=hello&sort=title', '/admin/collections/posts/hello']) {
    const response = await site.fetch(path)
    const location = new URL(response.headers.get('location') ?? '', 'http://site.test')

    expect(response.status, path).toBe(302)
    expect(location.pathname, path).toBe('/admin/sign-in')
    expect(location.searchParams.get('redirect'), path).toBe(path)
  }
})

test('the sign-in screen is open to an anonymous visitor, asks for a password and is not indexed', async () => {
  const page = await site.visit('/admin/sign-in?redirect=/admin/collections/posts')

  expect(page.status).toBe(200)
  expect(page.find('input[type=password]').length).toBe(1)
  expect(page.find('meta[name="robots"]').map(meta => meta.attributes.content)).toEqual(['noindex'])
  // No navigation or sign-out for someone who is not signed in.
  expect(page.find('.kcms-admin-who')).toEqual([])
})

test('a wrong password stays on the screen and says so; the right one signs in and returns to the deep link', async () => {
  const wrong = await site.submit(signIn, { password: 'nope', redirect: '/admin/collections/posts?q=a' }, { from: '/admin/sign-in' })

  expect(wrong.status).toBe(401)
  expect(wrong.html).toContain('That is not the right password.')
  expect((await site.fetch('/admin')).status).toBe(302)

  const right = await site.submit(signIn, { password: 'pw-editor', redirect: '/admin/collections/posts?q=a' }, { from: '/admin/sign-in' })

  expect(right.url).toBe('/admin/collections/posts?q=a')
  expect(right.status).toBe(200)
  expect(right.find('.kcms-admin-who').length).toBe(1)
  expect(right.html).toContain('Signed in as editor')
  expect((await site.fetch('/admin')).status).toBe(200)
})

test('the signed-in editor sees who they are, may edit, and is refused what the role does not list', async () => {
  const entry = { data: { title: 'Hello' }, create: false }

  expect((await site.fetch('/_kay/cms/entries/posts/hello', { method: 'DELETE' })).status).toBe(403)
  expect((await site.fetch('/_kay/cms/entries/posts/hello/publish', { method: 'POST' })).status).toBe(403)
  expect((await site.fetch('/_kay/cms/redirects/paths?q=a')).status).toBe(403)
  expect((await site.fetch('/admin/not-found')).status).toBe(403)
  expect((await site.fetch('/_kay/cms/entries/posts/hello')).status).toBe(200)
  expect(entry.create).toBe(false)
})

test('signing out ends the sign-in: the screens send the visitor to sign in again', async () => {
  const out = await site.submit(signOut, {}, { from: '/admin' })

  // It leads to the site's home, which the fixture has no page for.
  expect(out.url).toBe('/')
  expect((await site.fetch('/admin')).status).toBe(302)
  expect((await site.fetch('/_kay/cms/entries/posts/hello', { method: 'DELETE' })).status).toBe(401)
})

test('a sign-in with the admin password carries the admin role', async () => {
  await site.submit(signIn, { password: 'pw-admin' }, { from: '/admin/sign-in' })

  expect((await site.fetch('/admin/not-found')).status).toBe(200)
  expect((await site.fetch('/_kay/cms/redirects/paths?q=a')).status).toBe(200)
  await site.submit(signOut, {}, { from: '/admin' })
})

test('a redirect target that leaves the site leads to the admin instead', async () => {
  for (const hostile of ['https://evil.example/', '//evil.example', '/\\evil.example', '/%2F/evil.example', 'javascript:alert(1)']) {
    const page = await site.visit(`/admin/sign-in?redirect=${encodeURIComponent(hostile)}`)

    expect(page.find('input[name=redirect]')[0]?.attributes.value, hostile).toBe('/admin')

    const done = await site.submit(signIn, { password: 'pw-editor', redirect: hostile }, { from: '/admin/sign-in' })

    expect(done.url, hostile).toBe('/admin')
    await site.submit(signOut, {}, { from: '/admin' })
  }
})

test('a forged sign-in cookie opens nothing', async () => {
  for (const value of ['admin.9999999999999.AAAA', 'editor', '__proto__.9999999999999.x'])
    expect((await site.fetch('/admin', { headers: { cookie: `${SESSION_COOKIE}=${value}` } })).status, value).toBe(302)
})

test('the editor\'s sign-in link leads to the sign-in screen and back to the page, and never off the site', async () => {
  const back = await site.fetch('/_kay/cms/sign-in?redirect=%2Fadmin%2Fcollections%2Fposts%3Fq%3Da')
  const location = new URL(back.headers.get('location')!, 'http://site.test')

  expect(back.status).toBe(302)
  expect(location.pathname).toBe('/admin/sign-in')
  expect(location.searchParams.get('redirect')).toBe('/admin/collections/posts?q=a')

  const hostile = await site.fetch('/_kay/cms/sign-in?redirect=%2F%2Fevil.example')

  expect(new URL(hostile.headers.get('location')!, 'http://site.test').searchParams.get('redirect')).toBe('/admin')
})

test('a site without a password guard and without kayjs-auth sends the sign-in screen back to the guard\'s refusal', async () => {
  const plain = await siteWith(({ deny }) => deny(401, 'Sign in'))
  const response = await plain.fetch('/admin/sign-in')

  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe('/admin')
  expect((await plain.fetch('/admin')).status).toBe(401)
})

test('under a base, the sign-in leads back to the page asked for under that base', async () => {
  const options = { guard: passwordGuard('pw-editor') }
  const based = await testSite({ root: ROOT, base: '/site', extensions: [cms(options)] })

  cms(options)

  const response = await based.fetch('/site/admin/collections/posts?q=a')
  const location = new URL(response.headers.get('location') ?? '', 'http://site.test')

  expect(response.status).toBe(302)
  expect(location.pathname).toBe('/site/admin/sign-in')
  expect(location.searchParams.get('redirect')).toBe('/admin/collections/posts?q=a')

  const done = await based.submit(signIn, { password: 'pw-editor', redirect: location.searchParams.get('redirect') ?? '' }, { from: '/site/admin/sign-in' })

  expect(done.url).toBe('/site/admin/collections/posts?q=a')
})
