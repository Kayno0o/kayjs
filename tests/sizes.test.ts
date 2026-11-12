import { describe, expect, it } from 'bun:test'
import { compare, growth, origins, table, TOLERANCE } from '../scripts/size-table'

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
    expect(table(rows)).toMatch(/-1000\s+3\s+shrank/)
  })

  it('fails a page that gained an eager file however small, naming the page, the count change and the command, and marks one that lost a file as shrunk', () => {
    const gained = compare(BASELINE, { home: { gzip: 9010, files: 4 }, other: { gzip: 12_000, files: 2 } })
    const message = growth(gained)!

    expect(gained.map(row => row.grew)).toEqual([true, false])
    expect(message).toContain('home 3 -> 4 files')
    expect(message).not.toContain('other')
    expect(message).not.toContain(' B,')
    expect(message).toContain('bun scripts/sizes.ts --update')
    expect(table(gained)).toContain('3->4')

    const lost = compare(BASELINE, { home: { gzip: 9000, files: 2 }, other: { gzip: 12_000, files: 2 } })

    expect(lost.map(row => row.shrank)).toEqual([true, false])
    expect(growth(lost)).toBeUndefined()
  })

  it('takes a page without a baseline as growing from nothing', () => {
    expect(growth(compare({}, { fresh: { gzip: 500, files: 1 } }))).toContain('fresh +500 B')
  })
})

describe('the packages a page change came from', () => {
  it('names the packages whose minified bytes moved on a page that grew or shrank, the largest first, and none on a page within the tolerance', () => {
    const baseline = { home: { gzip: 9000, files: 3, packages: { 'kay': 20_000, 'kayjs-ui': 30_000 } }, other: { gzip: 12_000, files: 2, packages: { kay: 20_000 } } }
    const sizes = { home: { gzip: 9500, files: 3, packages: { 'kay': 19_990, 'kayjs-ui': 31_500, 'icons': 400 } }, other: { gzip: 12_010, files: 2, packages: { kay: 20_030 } } }
    const text = origins(baseline, sizes, compare(baseline, sizes))!

    expect(text).toContain('home: kayjs-ui +1500, icons +400, kay -10')
    expect(text).not.toContain('other')
  })

  it('says nothing when no page moved past the tolerance or the baseline records no packages', () => {
    expect(origins(BASELINE, BASELINE, compare(BASELINE, BASELINE))).toBeUndefined()

    const grown = { home: { gzip: 9500, files: 3 }, other: { gzip: 12_000, files: 2 } }

    expect(origins(BASELINE, grown, compare(BASELINE, grown))).toBeUndefined()
  })
})
