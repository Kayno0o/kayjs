import type { CmsOptions } from '../../../src/settings'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { cms } from '../../../src/extension'
import { passwordGuard } from '../../../src/password'
import { cmsSignInAs, cmsSignInWith, cmsSignOut, cmsTest } from '../../../src/test'

const ROOT = join(import.meta.dir, '..')

async function siteWith(passwords: string | Record<string, string>) {
  const options: CmsOptions = { guard: passwordGuard(passwords), roles: { editor: [], admin: ['redirects'] } }
  const made = await testSite({ root: ROOT, extensions: [cms(options)] })

  cms(options)

  return made
}

test('a lone password signs the site in as editor in one call, and out again', async () => {
  const site = await siteWith('pw-editor')

  expect((await site.fetch('/admin')).status).toBe(302)
  expect(await cmsTest(site).signInAs()).toBe('editor')
  expect((await site.fetch('/admin')).status).toBe(200)

  cmsTest(site).signOut()

  expect((await site.fetch('/admin')).status).toBe(302)
})

test('a role is named when the guard holds several, and a second call switches role', async () => {
  const site = await siteWith({ editor: 'pw-editor', admin: 'pw-admin' })

  await expect(cmsTest(site).signInAs()).rejects.toThrow('needs one of the guard\'s roles (editor, admin)')
  await expect(cmsTest(site).signInAs('nobody')).rejects.toThrow('"nobody"')

  await cmsTest(site).signInAs('editor')
  expect((await site.fetch('/_kay/cms/redirects/paths?q=a')).status).toBe(403)
  await cmsTest(site).signInAs('admin')
  expect((await site.fetch('/_kay/cms/redirects/paths?q=a')).status).toBe(200)
})

test('a wrong password is answered 401 through the form, the right one signs in', async () => {
  const site = await siteWith('pw-editor')
  const wrong = await cmsTest(site).signInWith('nope')

  expect(wrong.status).toBe(401)
  expect((await site.fetch('/admin')).status).toBe(302)

  expect((await cmsTest(site).signInWith('pw-editor')).status).toBe(200)
  expect((await site.fetch('/admin')).status).toBe(200)
})

test('the names before 1.100 still sign in and out', async () => {
  const site = await siteWith('pw-editor')

  expect(await cmsSignInAs(site)).toBe('editor')
  expect((await site.fetch('/admin')).status).toBe(200)

  cmsSignOut(site)
  expect((await site.fetch('/admin')).status).toBe(302)
  expect((await cmsSignInWith(site, 'pw-editor')).status).toBe(200)
})
