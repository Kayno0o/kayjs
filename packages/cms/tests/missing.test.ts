import type { MissingPath } from 'kay/library'
import { describe, expect, test } from 'bun:test'
import { missingRows, SHOWN } from '../src/missing'

const day = Date.UTC(2026, 9, 17, 12)
const row = (path: string, hits: number, extra: Partial<MissingPath> = {}): MissingPath => ({ path, hits, firstAt: day, lastAt: day, referrers: [], ...extra })

describe('missingRows', () => {
  test('words a path with its hits, its last day, its referrers and the redirect line to paste', () => {
    const [shown] = missingRows([row('/old/post', 12, { target: '/blog/post', reason: 'slug', referrers: [{ host: 'search.example', hits: 9 }, { host: 'a.example', hits: 2 }, { host: 'b.example', hits: 1 }, { host: 'c.example', hits: 1 }] })]).rows

    expect(shown).toEqual({ path: '/old/post', hits: 12, lastSeen: '2026-10-17 12:00', pages: [], from: 'search.example, a.example, b.example, ...', target: '/blog/post', reason: 'Same slug elsewhere', line: '\'/old/post\': \'/blog/post\',' })
  })

  test('names the pages of the site that link to a missing path apart from the hosts of other sites, three at most', () => {
    const [shown] = missingRows([row('/old', 5, { referrers: [{ host: 'site.example', page: '/blog/a', hits: 3 }, { host: 'search.example', hits: 2 }, { host: 'site.example', page: '/blog/b', hits: 1 }, { host: 'site.example', page: '/c', hits: 1 }, { host: 'site.example', page: '/d', hits: 1 }] })]).rows

    expect(shown?.pages).toEqual(['/blog/a', '/blog/b', '/c'])
    expect(missingRows([row('/dup', 1, { referrers: [{ host: 'www.site.example', page: '/a', hits: 2 }, { host: 'site.example', page: '/a', hits: 1 }] })]).rows[0]?.pages).toEqual(['/a'])
    expect(shown?.from).toBe('search.example')
  })

  test('words the time of the last visit in UTC, to the minute', () => {
    expect(missingRows([row('/late', 1, { lastAt: Date.UTC(2026, 0, 5, 23, 59, 59) })]).rows[0]?.lastSeen).toBe('2026-01-05 23:59')
  })

  test('keeps a path with no suggestion without a line, and a visit from nowhere without referrers', () => {
    expect(missingRows([row('/gone', 3)]).rows).toEqual([{ path: '/gone', hits: 3, lastSeen: '2026-10-17 12:00', pages: [], from: '', target: undefined, reason: undefined, line: undefined }])
  })

  test('escapes quotes and backslashes in the line, so pasted into kay.config.ts it is the string it names', () => {
    const [shown] = missingRows([row('/it\'s\\', 2, { target: '/x\'y', reason: 'similar' })]).rows

    expect(shown?.line).toBe('\'/it\\\'s\\\\\': \'/x\\\'y\',')
  })

  test('hands hostile text over as text alone, a path being no link', () => {
    const [shown] = missingRows([row('/<script>alert(1)</script>', 1, { referrers: [{ host: '‮evil.example', hits: 1 }] })]).rows

    expect(shown?.path).toBe('/<script>alert(1)</script>')
    expect(shown?.from).toBe('‮evil.example')
    expect(Object.keys(shown!)).not.toContain('href')
  })

  test('shows the most hit rows only, saying how many there are', () => {
    const many = Array.from({ length: SHOWN + 5 }, (_, i) => row(`/p${i}`, 1000 - i))
    const screen = missingRows(many)

    expect(screen.rows).toHaveLength(SHOWN)
    expect(screen.total).toBe(SHOWN + 5)
    expect(screen.rows[0]?.path).toBe('/p0')
  })

  test('says nothing recorded for none', () => {
    expect(missingRows([])).toEqual({ rows: [], total: 0 })
  })
})
