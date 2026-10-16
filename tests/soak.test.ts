import type { Readings } from '../bench/soak-verdict'
import { describe, expect, it } from 'bun:test'
import { growth, verdict } from '../bench/soak-verdict'

const FLAT = [10, 11, 10, 10, 10.5, 10, 10, 10.2, 10, 10]
const LEAKING = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
const LIMITS = { heap: 2, anon: 8 }
const readings = (overrides: Partial<Readings> = {}): Readings => ({ heap: FLAT, anon: FLAT, processes: 1, cpu: 100, ...overrides })

describe('the soak\'s verdict', () => {
  it('counts the rise of the floor over the second half, not the warm-up before it nor a peak the allocator returns', () => {
    expect(growth([5, 20, 30, 30, 30, 30, 30, 30, 30, 30])).toBe(0)
    expect(growth([30, 30, 30, 30, 30, 30, 30, 45, 30, 30])).toBe(0)
    expect(growth(LEAKING)).toBe(4)
  })

  it('fails memory growing past its limit whatever the load, naming the part and the kind', () => {
    const { failures } = verdict([{ name: 'kay dev', unit: 'edit (ms)', limits: LIMITS, current: readings({ heap: LEAKING }) }], false)

    expect(failures).toEqual(['kay dev: heap grew 4.0 MiB over the second half, past 2 MiB'])
  })

  it('fails samples taken from more than one process, which cannot be compared', () => {
    const { failures } = verdict([{ name: 'kay dev', unit: 'edit (ms)', limits: LIMITS, current: readings({ processes: 2 }) }], true)

    expect(failures).toEqual([expect.stringContaining('kay dev: its samples came from 2 processes')])
  })

  it.each([
    { quiet: true, cpu: 130, failed: true },
    { quiet: false, cpu: 130, failed: false },
    { quiet: true, cpu: 120, failed: false },
    { quiet: true, cpu: 50, failed: false },
  ])('judges a CPU per unit of $cpu against 100 on a quiet host $quiet: failed $failed', ({ quiet, cpu, failed }) => {
    const { failures, notes } = verdict([{ name: 'compiled server', unit: 'request (µs)', limits: LIMITS, current: readings({ cpu }), baseline: readings() }], quiet)

    expect(failures.length > 0).toBe(failed)
    expect(notes.some(note => note.includes('not judged on a busy host'))).toBe(!quiet && cpu > 125)
  })

  it('notes a run with no baseline rather than failing it', () => {
    const { failures, notes } = verdict([{ name: 'compiled server', unit: 'request (µs)', limits: LIMITS, current: readings() }], true)

    expect(failures).toEqual([])
    expect(notes).toEqual(['compiled server: no baseline, CPU not compared'])
  })
})
