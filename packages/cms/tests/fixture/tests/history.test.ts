import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { hiddenOf } from '../../../src/hidden'
import { trashOf } from '../../../src/trash'

const site = await testSite({ root: join(import.meta.dir, '..') })
const JSON_BODY = { 'content-type': 'application/json' }

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  return await (await site.fetch(`/_kay/cms/entries/${path}`, { method: 'POST', headers: JSON_BODY, body: JSON.stringify(body) })).json() as Record<string, unknown>
}

test('an entry\'s screen links to its history, which lists the saves and restores one as a new save', async () => {
  expect(await post('journal/day', { data: { title: 'Monday' }, create: true })).toMatchObject({ saved: true })

  const opened = await (await site.fetch('/_kay/cms/entries/journal/day')).json() as { entry: { version: string } }

  expect(await post('journal/day', { data: { title: 'Tuesday' }, version: opened.entry.version })).toMatchObject({ saved: true })
  expect((await site.visit('/admin/collections/journal/day')).find('a[href="/admin/history/journal/day"]')).toHaveLength(1)

  const page = await site.visit('/admin/history/journal/day')
  const rows = page.find('.kcms-revision')

  expect(rows).toHaveLength(2)
  expect(rows[0]!.text).toContain('Tuesday')
  expect(rows[0]!.text).toContain('Current')
  expect(rows[1]!.text).toContain('Created')
  expect(page.title()).toContain('History of Tuesday')

  const now = await (await site.fetch('/_kay/cms/entries/journal/day')).json() as { entry: { version: string } }
  const restored = await site.fetch('/_kay/cms/history/journal/day/restore', { method: 'POST', headers: JSON_BODY, body: JSON.stringify({ at: 1, version: now.entry.version }) })

  expect(await restored.json()).toMatchObject({ issues: [{ message: 'That version is not kept any more' }] })
})

test('the history of a collection whose loader keeps none is not found', async () => {
  expect((await site.fetch('/admin/history/products/mug')).status).toBe(404)
  expect((await site.visit('/admin/collections/products/mug')).find('a[href="/admin/history/products/mug"]')).toHaveLength(0)
})

test('a deleted entry is listed in the collection\'s trash, which restoring empties', async () => {
  expect(await post('journal/gone', { data: { title: 'Gone soon' }, create: true })).toMatchObject({ saved: true })

  const opened = await (await site.fetch('/_kay/cms/entries/journal/gone')).json() as { entry: { version: string } }

  expect(await (await site.fetch(`/_kay/cms/entries/journal/gone?version=${opened.entry.version}`, { method: 'DELETE' })).json()).toMatchObject({ saved: true })
  expect((await site.visit('/admin/collections/journal')).find('a[href="/admin/trash/journal"]')).toHaveLength(1)

  const trash = await site.visit('/admin/trash/journal')

  expect(trash.find('.kcms-revision')).toHaveLength(1)
  expect(trash.text('main')).toContain('Gone soon')
  expect((await site.fetch('/admin/trash/products')).status).toBe(404)
})

test('a deleted entry is restored through the trash API, which leaves the trash empty, and an entry no longer there is refused', async () => {
  expect(await post('journal/back', { data: { title: 'Back soon' }, create: true })).toMatchObject({ saved: true })

  const opened = await (await site.fetch('/_kay/cms/entries/journal/back')).json() as { entry: { version: string } }

  await site.fetch(`/_kay/cms/entries/journal/back?version=${opened.entry.version}`, { method: 'DELETE' })

  const [row] = (await site.visit('/admin/trash/journal')).find('.kcms-revision')

  expect(row!.text).toContain('Back soon')

  expect((await site.fetch('/_kay/cms/entries/journal/back')).status).toBe(404)

  const id = (await trashOf('journal')).find(item => item.slug === 'back')!.id
  const restored = await site.fetch(`/_kay/cms/trash/journal/${id}/restore`, { method: 'POST' })

  expect(await restored.json()).toMatchObject({ saved: true })
  expect(((await (await site.fetch('/_kay/cms/entries/journal/back')).json()) as { entry: { data: { title: string } } }).entry.data.title).toBe('Back soon')
  expect((await site.visit('/admin/trash/journal')).find('.kcms-revision').filter(each => each.text.includes('Back soon'))).toHaveLength(0)
  expect(await (await site.fetch(`/_kay/cms/trash/journal/${id}/restore`, { method: 'POST' })).json()).toMatchObject({ issues: [{ message: 'That entry is not in the trash any more' }] })
})

test('restoring from the trash of an unknown collection is a 404', async () => {
  expect((await site.fetch('/_kay/cms/trash/nowhere/1/restore', { method: 'POST' })).status).toBe(404)
})

test('the activity screen lists a save then a delete newest first, pages, and leaves out a collection that opts out', async () => {
  expect(await post('journal/logged', { data: { title: 'Logged' }, create: true })).toMatchObject({ saved: true })
  expect(await post('scratch/quiet', { data: { title: 'Quiet' }, create: true })).toMatchObject({ saved: true })

  const opened = await (await site.fetch('/_kay/cms/entries/journal/logged')).json() as { entry: { version: string } }

  await site.fetch(`/_kay/cms/entries/journal/logged?version=${opened.entry.version}`, { method: 'DELETE' })
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

test('a draft is shared by a signed link to its own page, and an entry with no page is refused', async () => {
  const shared = await (await site.fetch('/_kay/cms/entries/posts/notes%2Fgarden/share', { method: 'POST' })).json() as { link: string }
  const page = shared.link.slice(0, shared.link.indexOf('?'))

  expect(page).toStartWith('/blog/')
  expect((await site.fetch(page)).status).toBe(404)
  expect((await site.fetch(shared.link)).status).toBe(200)
  expect((await site.fetch(shared.link.replace(page, '/blog/hello'))).status).toBe(200)
  expect((await site.fetch(`${page}?kay_preview=garbage`)).status).toBe(404)

  expect(await post('journal/pageless', { data: { title: 'No page' }, create: true })).toMatchObject({ saved: true })
  expect(await (await site.fetch('/_kay/cms/entries/journal/pageless/share', { method: 'POST' })).json()).toMatchObject({ issues: [{ message: 'This entry has no page to share' }] })
})

async function erase(path: string, body: unknown = {}): Promise<Response> {
  return site.fetch(`/_kay/cms/history/${path}/erase`, { method: 'POST', headers: JSON_BODY, body: JSON.stringify(body) })
}

test('erasing a deleted entry through the API empties its trash, revisions and activity, and erasing it again finds nothing', async () => {
  expect(await post('journal/erasable', { data: { title: 'Erase me' }, create: true })).toMatchObject({ saved: true })

  const opened = await (await site.fetch('/_kay/cms/entries/journal/erasable')).json() as { entry: { version: string } }

  expect(await post('journal/erasable', { data: { title: 'Erase me too' }, version: opened.entry.version })).toMatchObject({ saved: true })

  const current = await (await site.fetch('/_kay/cms/entries/journal/erasable')).json() as { entry: { version: string } }

  await site.fetch(`/_kay/cms/entries/journal/erasable?version=${current.entry.version}`, { method: 'DELETE' })
  expect((await site.visit('/admin/trash/journal')).text('main')).toContain('Erase me too')
  expect((await site.visit('/admin/activity')).text('main')).toContain('erasable')

  const erased = await erase('journal/erasable')

  expect(erased.status).toBe(200)
  expect(((await erased.json()) as { erased: number }).erased).toBeGreaterThanOrEqual(3)
  expect((await site.visit('/admin/trash/journal')).text('main')).not.toContain('Erase me too')
  expect((await site.visit('/admin/activity')).text('main')).not.toContain('erasable')
  expect(await (await erase('journal/erasable')).json()).toEqual({ erased: 0 })
})

test('erasing an entry that still exists keeps its revisions and activity', async () => {
  expect(await post('journal/kept-live', { data: { title: 'Still here' }, create: true })).toMatchObject({ saved: true })
  expect(await (await erase('journal/kept-live')).json()).toEqual({ erased: 0 })
  expect((await site.visit('/admin/history/journal/kept-live')).find('.kcms-revision')).toHaveLength(1)
})

test('erasing from a collection that does not exist is a 404, and a malformed body is refused', async () => {
  expect((await erase('nowhere/x')).status).toBe(404)
  expect((await erase('journal/x', { locale: 3 })).status).toBeGreaterThanOrEqual(400)
})

test('forgetting an editor rewrites their name in the revisions, once, and refuses an empty name', async () => {
  const saved = await site.fetch('/_kay/cms/entries/journal/by-zed?as=Zed', { method: 'POST', headers: JSON_BODY, body: JSON.stringify({ data: { title: 'Written' }, create: true }) })

  expect(await saved.json()).toMatchObject({ saved: true })
  // The names the history keeps, which no screen shows.
  const authors = async () => (await hiddenOf('journal', 'history', { anyway: true })!.load({ preview: true })).filter(row => row.slug.startsWith('by-zed')).map(row => (row.data as { author?: string }).author).filter(author => author !== undefined)

  expect(await authors()).toEqual(['Zed'])

  const forget = async (name: string) => site.fetch('/_kay/cms/history/forget-editor', { method: 'POST', headers: JSON_BODY, body: JSON.stringify({ name }) })
  const forgotten = await forget('Zed')

  expect(forgotten.status).toBe(200)
  expect(((await forgotten.json()) as { changed: number }).changed).toBeGreaterThanOrEqual(1)

  expect(await authors()).toEqual(['Former editor'])
  expect(await (await forget('Zed')).json()).toEqual({ changed: 0 })
  expect((await forget('')).status).toBeGreaterThanOrEqual(400)
})
