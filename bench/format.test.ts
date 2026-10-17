import { describe, expect, it } from 'bun:test'
import { medianOf, seconds } from './format'

describe('medianOf', () => {
  it('takes each number\'s median across runs, through nested objects and arrays, keeping the first run\'s strings', () => {
    const runs = [
      { ssr: { avg: 3 }, operations: [{ name: 'create', median: 40 }] },
      { ssr: { avg: 1 }, operations: [{ name: 'create', median: 27 }] },
      { ssr: { avg: 2 }, operations: [{ name: 'create', median: 30 }] },
    ]

    expect(medianOf(runs)).toEqual({ ssr: { avg: 2 }, operations: [{ name: 'create', median: 30 }] })
    expect(medianOf([[1, 4], [3, 8]])).toEqual([2, 6])
  })
})

describe('seconds', () => {
  it('keeps two decimals under ten seconds, one above', () => {
    expect(seconds(0.123)).toBe('0.12 s')
    expect(seconds(12.34)).toBe('12.3 s')
  })
})
