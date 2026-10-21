import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { trashOf } from '../../../src/trash'

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

test('a deleted entry is restored through the trash API, which leaves the trash empty, and an entry no longer there is refused', async () => {
  expect(await post('journal/back', { data: { title: 'Back soon' }, create: true })).toMatchObject({ saved: true })

  const opened = await (await site.fetch('/api/cms/entries/journal/back')).json() as { entry: { version: string } }

  await site.fetch(`/api/cms/entries/journal/back?version=${opened.entry.version}`, { method: 'DELETE' })

  const [row] = (await site.visit('/admin/trash/journal')).find('.kcms-revision')

  expect(row!.text).toContain('Back soon')

  expect((await site.fetch('/api/cms/entries/journal/back')).status).toBe(404)

  const id = (await trashOf('journal')).find(item => item.slug === 'back')!.id
  const restored = await site.fetch(`/api/cms/trash/journal/${id}/restore`, { method: 'POST' })

  expect(await restored.json()).toMatchObject({ saved: true })
  expect(((await (await site.fetch('/api/cms/entries/journal/back')).json()) as { entry: { data: { title: string } } }).entry.data.title).toBe('Back soon')
  expect((await site.visit('/admin/trash/journal')).find('.kcms-revision').filter(each => each.text.includes('Back soon'))).toHaveLength(0)
  expect(await (await site.fetch(`/api/cms/trash/journal/${id}/restore`, { method: 'POST' })).json()).toMatchObject({ issues: [{ message: 'That entry is not in the trash any more' }] })
})

test('restoring from the trash of an unknown collection is a 404', async () => {
  expect((await site.fetch('/api/cms/trash/nowhere/1/restore', { method: 'POST' })).status).toBe(404)
})

test('the activity screen lists a save then a delete newest first, pages, and leaves out a collection that opts out', async () => {
  expect(await post('journal/logged', { data: { title: 'Logged' }, create: true })).toMatchObject({ saved: true })
  expect(await post('scratch/quiet', { data: { title: 'Quiet' }, create: true })).toMatchObject({ saved: true })

  const opened = await (await site.fetch('/api/cms/entries/journal/logged')).json() as { entry: { version: string } }

  await site.fetch(`/api/cms/entries/journal/logged?version=${opened.entry.version}`, { method: 'DELETE' })
  expect((await site.visit('/admin')).find('a[href="/admin/activity"]')).toHaveLength(1)

  const page = await site.visit('/admin/activity')
  const rows = page.find('.kcms-revision').map(row => row.text)
  const deleted = rows.findIndex(text => text.includes('Deleted') && text.includes('logged'))
  const created = rows.findIndex(text => text.includes('Created') && text.includes('logged'))

  expect(deleted).toBeGreaterThanOrEqual(0)
  expect(created).toBeGreaterThan(deleted)
  expect(page.text('main')).not.toContain('quiet')
  expect(page.title()).toContain('Activity')
  expect((await site.visit('/admin/collections/scratch')).find('a[href="/admin/trash/scratch"]')).toHaveLength(0)
})

test('the activity screen pages at the page size', async () => {
  for (let n = 0; n < 55; n++)
    expect(await post(`journal/many-${n}`, { data: { title: `n${n}` }, create: true })).toMatchObject({ saved: true })

  const first = await site.visit('/admin/activity')
  const second = await site.visit('/admin/activity?page=2')

  expect(first.find('.kcms-revision')).toHaveLength(50)
  expect(second.find('.kcms-revision').length).toBeGreaterThan(0)
  expect(second.find('.kcms-revision').length).toBeLessThan(50)
  expect(first.find('a[href*="page=2"]').length).toBeGreaterThan(0)
})
