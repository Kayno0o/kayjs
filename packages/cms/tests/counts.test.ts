import type { CollectionInfo, SourceEntry } from '../src/kay/contract'
import { beforeEach, describe, expect, test } from 'bun:test'
import { countEntries, forgetCounts } from '../src/counts'

const posts: CollectionInfo = { name: 'posts', kind: 'folder', schema: { type: 'object', properties: { title: { type: 'string' }, draft: { type: 'boolean' }, publishAt: { type: 'string' } } }, components: [], localized: false, draftField: 'draft', publishField: 'publishAt' }
const NOW = Date.parse('2026-06-01T00:00:00Z')
const entry = (slug: string, draft: boolean, publishAt?: string): SourceEntry => ({ slug, data: { title: slug, draft, ...publishAt === undefined ? {} : { publishAt } }, draft })
const entriesNow = [entry('a', true), entry('b', false), entry('c', false, '2026-07-01T00:00:00Z'), entry('d', false, '2026-05-01T00:00:00Z')]

let reads = 0

function read(found: SourceEntry[] = entriesNow) {
  return async () => {
    reads++

    return found
  }
}

beforeEach(() => {
  forgetCounts()
  reads = 0
})

describe('countEntries', () => {
  test('counts the drafts and the entries scheduled ahead', async () => {
    expect(await countEntries(posts, read(), NOW)).toEqual({ drafts: 1, scheduled: 1 })
  })

  test('reads the entries once while the count is kept, and again once it is dropped or old', async () => {
    await countEntries(posts, read(), NOW)
    await countEntries(posts, read(), NOW + 1000)
    expect(reads).toBe(1)

    forgetCounts()
    await countEntries(posts, read(), NOW + 2000)
    expect(reads).toBe(2)

    await countEntries(posts, read(), NOW + 2000 + 60_000)
    expect(reads).toBe(3)
  })

  test('shares one read between loads made at the same time', async () => {
    await Promise.all([countEntries(posts, read(), NOW), countEntries(posts, read(), NOW)])
    expect(reads).toBe(1)
  })

  test('keeps the scheduled count in step with the clock without a new read', async () => {
    const soon = [entry('c', false, new Date(NOW + 10_000).toISOString())]

    expect((await countEntries(posts, read(soon), NOW))?.scheduled).toBe(1)
    expect((await countEntries(posts, read(soon), NOW + 20_000))?.scheduled).toBe(0)
    expect(reads).toBe(1)
  })

  test('does not keep a read that failed', async () => {
    const failing = async () => {
      reads++

      return undefined
    }

    expect(await countEntries(posts, failing, NOW)).toBeUndefined()
    expect(await countEntries(posts, read(), NOW)).toEqual({ drafts: 1, scheduled: 1 })
    expect(reads).toBe(2)
  })
})
