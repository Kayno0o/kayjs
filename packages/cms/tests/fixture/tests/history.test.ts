import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, '..') })
const JSON_BODY = { 'content-type': 'application/json' }

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  return await (await site.fetch(`/api/cms/entries/${path}`, { method: 'POST', headers: JSON_BODY, body: JSON.stringify(body) })).json() as Record<string, unknown>
}

test('an entry\'s screen links to its history, which lists the saves and restores one as a new save', async () => {
  expect(await post('journal/day', { data: { title: 'Monday' }, create: true })).toMatchObject({ saved: true })

  const opened = await (await site.fetch('/api/cms/entries/journal/day')).json() as { entry: { version: string } }

  expect(await post('journal/day', { data: { title: 'Tuesday' }, version: opened.entry.version })).toMatchObject({ saved: true })
  expect((await site.visit('/admin/collections/journal/day')).find('a[href="/admin/history/journal/day"]')).toHaveLength(1)

  const page = await site.visit('/admin/history/journal/day')
  const rows = page.find('.kcms-revision')

  expect(rows).toHaveLength(2)
  expect(rows[0]!.text).toContain('Tuesday')
  expect(rows[0]!.text).toContain('Current')
  expect(rows[1]!.text).toContain('Created')
  expect(page.title()).toContain('History of Tuesday')

  const now = await (await site.fetch('/api/cms/entries/journal/day')).json() as { entry: { version: string } }
  const restored = await site.fetch('/api/cms/history/journal/day/restore', { method: 'POST', headers: JSON_BODY, body: JSON.stringify({ at: 1, version: now.entry.version }) })

  expect(await restored.json()).toMatchObject({ issues: [{ message: 'That version is not kept any more' }] })
})

test('the history of a collection whose loader keeps none is not found', async () => {
  expect((await site.fetch('/admin/history/products/mug')).status).toBe(404)
  expect((await site.visit('/admin/collections/products/mug')).find('a[href="/admin/history/products/mug"]')).toHaveLength(0)
})

test('a deleted entry is listed in the collection\'s trash, which restoring empties', async () => {
  expect(await post('journal/gone', { data: { title: 'Gone soon' }, create: true })).toMatchObject({ saved: true })

  const opened = await (await site.fetch('/api/cms/entries/journal/gone')).json() as { entry: { version: string } }

  expect(await (await site.fetch(`/api/cms/entries/journal/gone?version=${opened.entry.version}`, { method: 'DELETE' })).json()).toMatchObject({ saved: true })
  expect((await site.visit('/admin/collections/journal')).find('a[href="/admin/trash/journal"]')).toHaveLength(1)

  const trash = await site.visit('/admin/trash/journal')

  expect(trash.find('.kcms-revision')).toHaveLength(1)
  expect(trash.text('main')).toContain('Gone soon')
  expect((await site.fetch('/admin/trash/products')).status).toBe(404)
})
