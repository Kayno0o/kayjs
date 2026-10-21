import type { Guard } from 'kay'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { cms } from '../../../src/extension'

// The fixture's own root layout draws a site header and footer, so the admin must keep clear of it and the site's pages of the admin's chrome.
const ROOT = join(import.meta.dir, '..')

// The fixture's kay.config.ts calls cms() as it loads, after this one, so the settings are given again once it has.
async function rootSite(guard: Guard) {
  const options = { prefix: '/', guard }
  const made = await testSite({ root: ROOT, extensions: [cms(options)] })

  cms(options)

  return made
}

const site = await rootSite(() => undefined)

const robots = (page: Awaited<ReturnType<typeof site.visit>>) => page.find('meta[name="robots"]').map(meta => meta.attributes.content)

test('a cms at the root prefix keeps its own chrome where the app has a root layout, and the site header stays out of it', async () => {
  for (const path of ['/', '/not-found', '/uploads', '/collections/posts']) {
    const page = await site.visit(path)

    expect(page.find('.kcms-admin').length, path).toBe(1)
    expect(page.find('.site-header'), path).toEqual([])
    expect(page.find('.site-footer'), path).toEqual([])
    expect(robots(page), path).toEqual(['noindex'])
  }
})

test('the app\'s pages keep the site\'s layout and stay indexable', async () => {
  for (const path of ['/about', '/blog/hello']) {
    const page = await site.visit(path)

    expect(page.find('.site-header').length, path).toBe(1)
    expect(page.find('.kcms-admin'), path).toEqual([])
    expect(robots(page), path).toEqual([])
  }
})

test('every link of the screens stays at the root, with no // address', async () => {
  const page = await site.visit('/')
  const links = page.find('a').map(link => link.attributes.href)

  expect(links).toContain('/collections/posts')
  expect(links).toContain('/not-found')
  expect(links.filter(href => href?.startsWith('//'))).toEqual([])
  expect(page.find('.kcms-admin-home')[0]?.attributes.href).toBe('/')
})

test('the guard covers the screens and nothing else of the site', async () => {
  const closed = await rootSite(({ deny }) => deny(403, 'Editors only'))

  expect((await closed.fetch('/not-found')).status).toBe(403)
  expect((await closed.fetch('/about')).status).toBe(200)
})
