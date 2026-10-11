import { join } from 'node:path'
import process from 'node:process'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'

// Until kay renders the editor in edit mode (kaynooo/kayjs#262), the fixture's pages render it themselves.
const ROOT = join(import.meta.dir, '..')
// kay check prints this line on success since kay 1.18, nothing before.
const CLEAN = /^(?:checked with no problems in \d+ ms\n)?$/
const site = await testSite({ root: ROOT })

test('kay check passes on the fixture, the editor\'s components included', async () => {
  const check = Bun.spawn([process.execPath, join(ROOT, '..', '..', 'node_modules', '.bin', 'kay'), 'check'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

  expect(await new Response(check.stdout).text() + await new Response(check.stderr).text()).toMatch(CLEAN)
  expect(await check.exited).toBe(0)
}, 60_000)

test('the editor renders a form per entry the page read, each loading in the browser', async () => {
  const page = await site.visit('/')

  expect(page.find('aside.kcms-editor-open')[0]?.attributes['aria-label']).toBe('Content editor')
  expect(page.find('.kcms-entry-title').map(title => title.text)).toEqual(['Posts', 'Pages'])
  expect(page.find('.kcms-entry-slug').map(slug => slug.text)).toEqual(['hello', 'about (fr)'])
  expect(page.find('.kcms-entry-loading')).toHaveLength(2)
})

test('the editor says when nothing on the page comes from a collection', async () => {
  const page = await site.visit('/empty')

  expect(page.find('.kcms-editor-empty')[0]?.text).toBe('Nothing on this page comes from a collection.')
})

test('the screens list each collection with its entry count', async () => {
  const page = await site.visit('/admin')

  expect(page.find('.kui-card-row a').map(link => [link.text, link.attributes.href])).toEqual([['Posts', '/admin/collections/posts'], ['Pages', '/admin/collections/pages']])
  expect(page.text('main')).toContain('2 entries')
})

test('a collection lists its entries, with a draft to publish, and searches them', async () => {
  const page = await site.visit('/admin/collections/posts')

  expect(page.find('.kcms-entries a').map(link => [link.text, link.attributes.href])).toEqual([
    ['Hello world', '/admin/collections/posts/hello'],
    ['Edit on page', '/admin/page?path=%2Fblog%2Fhello'],
    ['Spring garden', '/admin/collections/posts/notes/garden'],
  ])
  expect(page.find('.kcms-entries button').map(button => button.text)).toContain('Publish')

  const searched = await site.visit('/admin/collections/posts?q=garden')

  expect(searched.find('.kcms-entries a').map(link => link.text)).toEqual(['Spring garden'])
})

test('an entry opens in a form of its collection\'s fields, nested slugs included', async () => {
  const page = await site.visit('/admin/collections/posts/notes/garden')

  expect(page.title()).toBe('notes/garden - Posts')
  expect(page.find('[data-kcms-path]').map(field => field.attributes['data-kcms-path'])).toEqual(['title', 'draft'])
  expect(page.find('[data-kcms-body]')).toHaveLength(1)
})

test('a new entry asks for its slug, and a locale in a localized collection', async () => {
  expect((await site.visit('/admin/new/posts')).find('.kui-label-text').map(label => label.text)).not.toContain('Locale')
  expect((await site.visit('/admin/new/pages')).find('.kui-label-text').map(label => label.text)).toContain('Locale')
})

test('an unknown collection or entry is a 404', async () => {
  expect((await site.fetch('/admin/collections/nope')).status).toBe(404)
  expect((await site.fetch('/admin/collections/posts/nope')).status).toBe(404)
  expect((await site.fetch('/admin/new/nope')).status).toBe(404)
})
