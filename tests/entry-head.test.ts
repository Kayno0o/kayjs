import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const FIXTURE = 'tests/fixtures/entry-head/src'
const site = await testSite({ routes: `${FIXTURE}/routes`, content: `${FIXTURE}/content.config.ts`, islands: false, site: 'https://notes.example', seo: { name: 'Notes', titleTemplate: '%s | Notes' } })

afterAll(async () => site.close())

describe('the head of a page showing one entry', () => {
  it('takes the title, description and article tags from the entry, over its layout\'s', async () => {
    const page = await site.visit('/notes/full')

    expect(page.title()).toBe('A full note | Notes')
    expect(page.meta('description')).toBe('What it says.')
    expect(page.meta('og:type')).toBe('article')
    expect(page.meta('article:published_time')).toBe('2026-03-04T10:00:00.000Z')
    expect(page.meta('og:title')).toBe('A full note')
    expect(page.meta('og:description')).toBe('What it says.')
  })

  it('reads a date alone as 00:00 UTC, and leaves a note without a date a website', async () => {
    expect((await site.visit('/notes/dated')).meta('article:published_time')).toBe('2026-03-05T00:00:00.000Z')

    const plain = await site.visit('/notes/plain')

    expect(plain.title()).toBe('Plain | Notes')
    expect(plain.meta('og:type')).toBe('website')
    expect(plain.meta('article:published_time')).toBeUndefined()
    expect(plain.meta('description')).toBe('Layout description')
  })

  it('leaves the layout\'s title where the entry has none', async () => {
    const page = await site.visit('/notes/untitled')

    expect(page.title()).toBe('Layout title | Notes')
    expect(page.meta('description')).toBe('No title here.')
  })

  it('lets the page replace each of them', async () => {
    const page = await site.visit('/own/full')

    expect(page.title()).toBe('Mine | Notes')
    expect(page.meta('og:type')).toBe('website')
    expect(page.meta('description')).toBe('What it says.')
    expect(page.meta('article:published_time')).toBe('2026-03-04T10:00:00.000Z')
  })

  it('lets the page replace the description and the published time too', async () => {
    const page = await site.visit('/ownmeta/full')

    expect(page.meta('description')).toBe('Mine')
    expect(page.meta('article:published_time')).toBe('2001-01-01T00:00:00.000Z')
  })

  it('reads only a Date field, so a date written as text leaves a website', async () => {
    const page = await site.visit('/texts/one')

    expect(page.title()).toBe('Text one | Notes')
    expect(page.meta('og:type')).toBe('website')
    expect(page.meta('article:published_time')).toBeUndefined()
  })

  it('reads a nested entry through a catch-all param, for a page the sitemap lists', async () => {
    expect((await site.visit('/deep/nested/one')).title()).toBe('Nested one | Notes')
  })

  it('takes the date of the collection\'s publishAt field', async () => {
    const page = await site.visit('/events/launch')

    expect(page.meta('og:type')).toBe('article')
    expect(page.meta('article:published_time')).toBe('2026-05-01T09:00:00.000Z')
  })

  it('gives an entry held back, or none, the head of its layout alone', async () => {
    const missing = await site.visit('/notes/drafted')
    const none = await site.visit('/notes/nothing')

    expect(missing.status).toBe(404)
    expect(none.status).toBe(404)
    expect(missing.meta('article:published_time')).toBeUndefined()
  })
})
