import { describe, expect, it } from 'bun:test'
import { compare, growth, table, TOLERANCE } from '../scripts/size-table'

const BASELINE = { home: { gzip: 9000, files: 3 }, other: { gzip: 12_000, files: 2 } }

describe('the eager JS sizes against their baseline', () => {
  it('lets a page differ by up to the tolerance and fails the one past it, naming the page, the delta and the command accepting it', () => {
    const within = compare(BASELINE, { home: { gzip: 9000 + TOLERANCE, files: 3 }, other: { gzip: 12_000 - TOLERANCE, files: 2 } })

    expect(within.map(row => row.grew)).toEqual([false, false])
    expect(growth(within)).toBeUndefined()

    const over = compare(BASELINE, { home: { gzip: 9000 + TOLERANCE + 1, files: 3 }, other: { gzip: 12_010, files: 2 } })
    const message = growth(over)!

    expect(message).toContain(`home +${TOLERANCE + 1} B`)
    expect(message).not.toContain('other')
    expect(message).toContain('bun scripts/sizes.ts --update')
  })

  it('marks a page that shrank past the tolerance without failing', () => {
    const rows = compare(BASELINE, { home: { gzip: 8000, files: 3 }, other: { gzip: 12_000, files: 2 } })

    expect(rows.map(row => row.shrank)).toEqual([true, false])
    expect(growth(rows)).toBeUndefined()
    expect(table(rows)).toMatch(/-1000\s+shrank/)
  })

  it('takes a page without a baseline as growing from nothing', () => {
    expect(growth(compare({}, { fresh: { gzip: 500, files: 1 } }))).toContain('fresh +500 B')
  })
})
