import { describe, expect, test } from 'bun:test'
import { chartData, indexAt, labelTimes, positionOf, tickIndices, xAxisOptions } from '../src/chart-axis'

const DAYS = ['2026-01-01', '2026-01-02', '2026-01-11']

describe('chart axis', () => {
  test('spreads at most five ticks, the first and last always among them', () => {
    expect(tickIndices(3)).toEqual([0, 1, 2])
    expect(tickIndices(9)).toEqual([0, 2, 4, 6, 8])
    expect(tickIndices(10)).toEqual([0, 2, 5, 7, 9])
  })

  test('reads times only when every label is a date and they span some time', () => {
    expect(labelTimes(DAYS)).toHaveLength(3)
    expect(labelTimes(['10:00', '10:05'])).toBeNull()
    expect(labelTimes(['2026-01-01', '2026-01-01'])).toBeNull()
    expect(labelTimes(['2026-01-01'])).toBeNull()
  })

  test('places points by time when there are times, and evenly otherwise', () => {
    const times = labelTimes(DAYS)

    expect(positionOf(1, 3, times)).toBeCloseTo(0.1)
    expect(positionOf(1, 3, null)).toBe(0.5)
    expect(positionOf(0, 1, null)).toBe(0)
  })

  test('finds the point nearest a position, by time when there are times', () => {
    const times = labelTimes(DAYS)

    expect(indexAt(0.3, 3, times)).toBe(1)
    expect(indexAt(0.8, 3, times)).toBe(2)
    expect(indexAt(0.3, 3, null)).toBe(1)
    expect(indexAt(1.4, 3, null)).toBe(2)
    expect(indexAt(0.5, 1, null)).toBe(0)
  })

  test('pairs each value with its time when there are times', () => {
    const times = [1, 2]

    expect(chartData(['a', 'b'], [[5, null]], times).series).toEqual([[{ x: 1, y: 5 }, { x: 2, y: null }]])
    expect(chartData(['a', 'b'], [[5, null]], null).series).toEqual([[5, null]])
  })

  test('labels only the ticks, as dates on a time axis and as written otherwise', () => {
    expect(xAxisOptions(DAYS, labelTimes(DAYS), false)).toEqual({ showLabel: false, showGrid: false })

    const timed = xAxisOptions(DAYS, labelTimes(DAYS), true)

    expect(timed.ticks).toEqual(labelTimes(DAYS)!)
    expect(timed.labelInterpolationFnc?.(labelTimes(DAYS)![2]!, 2)).toBe('11 Jan')

    const labels = ['10:00', '10:05', '10:10', '10:15', '10:20', '10:25']
    const plain = xAxisOptions(labels, null, true)

    expect(labels.map((label, index) => plain.labelInterpolationFnc?.(label, index))).toEqual(['10:00', '10:05', null, '10:15', '10:20', '10:25'])
  })
})
