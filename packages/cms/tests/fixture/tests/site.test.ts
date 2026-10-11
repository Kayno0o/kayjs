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
