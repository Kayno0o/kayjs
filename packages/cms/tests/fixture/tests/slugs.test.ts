import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, '..') })

test('lists the slugs a collection holds, for a new entry to flag a taken one and a folder typo', async () => {
  const response = await site.fetch('/api/cms/slugs/posts')
  const slugs = (await response.json() as { slug: string }[]).map(entry => entry.slug).sort()

  expect(response.status).toBe(200)
  expect(slugs).toContain('hello')
  expect(slugs.some(slug => slug.startsWith('notes/'))).toBe(true)
})

test('lists a loaded collection\'s slugs, 404 for a collection the site lacks, and 403 to a request the guard refuses', async () => {
  const loaded = await (await site.fetch('/api/cms/slugs/partners')).json() as { slug: string }[]

  expect(loaded.length).toBeGreaterThan(0)
  expect((await site.fetch('/api/cms/slugs/nothing')).status).toBe(404)
  expect((await site.fetch('/api/cms/slugs/posts', { headers: { 'x-deny': '1' } })).status).toBe(403)
})
