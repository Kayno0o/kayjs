import type { Guard } from 'kay'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { cms } from '../../../src/extension'
import { branding } from '../src/cms-settings'

const ROOT = join(import.meta.dir, '..')

// The fixture's kay.config.ts calls cms() as it loads, after this one, so the settings are given again once it has.
async function adminSite(options: Parameters<typeof cms>[0], site: Parameters<typeof testSite>[0] = {}) {
  const guard: Guard = () => undefined
  const made = await testSite({ root: ROOT, ...site, extensions: [cms({ guard, ...options })] })

  cms({ guard, ...options })

  return made
}

const crumbs = (page: Awaited<ReturnType<Awaited<ReturnType<typeof adminSite>>['visit']>>) => page.find('.kcms-entry-crumb').map(link => [link.text, link.attributes.href])

test('shows the logo before the name in the header, the name staying the link\'s text', async () => {
  const page = await (await adminSite({ logo: '/logo.svg' })).visit('/admin')

  expect(page.find('.kcms-admin-logo').map(logo => [logo.attributes.src, logo.attributes.alt])).toEqual([['/logo.svg', '']])
  expect(page.find('.kcms-admin-home')[0]?.text).toBe('Content admin')
  expect(page.find('.kcms-admin-home')[0]?.attributes.href).toBe('/admin')
})

test('draws the logo of the settings module with its alt and size, over the one cms({ logo }) gives', async () => {
  branding.logo = { src: '/brand.svg', alt: 'Acme', width: 40, height: 24 }

  try {
    const page = await (await adminSite({ logo: '/logo.svg' })).visit('/admin')

    expect(page.find('.kcms-admin-logo').map(logo => [logo.attributes.src, logo.attributes.alt, logo.attributes.width, logo.attributes.height])).toEqual([['/brand.svg', 'Acme', '40', '24']])
  }
  finally {
    branding.logo = undefined
  }
})

test('refuses a settings logo that points at another host', async () => {
  branding.logo = { src: '//evil.example/logo.svg', alt: 'x' }

  try {
    const response = await (await adminSite({})).visit('/admin')

    expect(response.status).toBe(500)
  }
  finally {
    branding.logo = undefined
  }
})

test('has no logo unless the app gives one', async () => {
  expect((await (await adminSite({})).visit('/admin')).find('.kcms-admin-logo')).toEqual([])
})

test('an entry screen\'s crumbs run from the content list through its collection, and a new entry\'s too', async () => {
  const site = await adminSite({})

  expect(crumbs(await site.visit('/admin/collections/posts/hello'))).toEqual([['Content', '/admin'], ['Posts', '/admin/collections/posts']])
  expect(crumbs(await site.visit('/admin/new/posts'))).toEqual([['Content', '/admin'], ['Posts', '/admin/collections/posts']])
  expect(crumbs(await site.visit('/admin/collections/welcome/index'))).toEqual([['Content', '/admin']])
  expect((await site.visit('/admin/collections/posts/hello')).find('nav[aria-label="Breadcrumb"]')).toHaveLength(1)
})

test('under a base and a trailing slash, the logo and the links carry the base, as kay writes links', async () => {
  const site = await adminSite({ logo: '/logo.svg' }, { base: '/cms', trailingSlash: 'always' })
  const page = await site.visit('/admin/collections/posts/hello/')

  expect(crumbs(page)).toEqual([['Content', '/cms/admin'], ['Posts', '/cms/admin/collections/posts']])
  expect(page.find('.kcms-admin-home')[0]?.attributes.href).toBe('/cms/admin')
  expect(page.find('.kcms-admin-logo')[0]?.attributes.src).toBe('/cms/logo.svg')
})
