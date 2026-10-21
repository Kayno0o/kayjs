import type { LabelContext } from '../src/chart-axis'
import { describe, expect, test } from 'bun:test'
import { FixedScaleAxis } from 'chartist'
import { chartData, headings, indexAt, labelTimes, positionOf, tickIndices, xAxisOptions } from '../src/chart-axis'

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
    expect(xAxisOptions(DAYS, labelTimes(DAYS), false, FixedScaleAxis)).toEqual({ showLabel: false, showGrid: false })

    const timed = xAxisOptions(DAYS, labelTimes(DAYS), true, FixedScaleAxis)

    expect(timed.ticks).toEqual(labelTimes(DAYS)!)
    expect(timed.labelInterpolationFnc?.(labelTimes(DAYS)![2]!, 2)).toBe('11 Jan')

    const labels = ['10:00', '10:05', '10:10', '10:15', '10:20', '10:25']
    const plain = xAxisOptions(labels, null, true, FixedScaleAxis)

    expect(labels.map((label, index) => plain.labelInterpolationFnc?.(label, index))).toEqual(['10:00', '10:05', null, '10:15', '10:20', '10:25'])
  })

  test('reads a date with a time of day as a moment, so points spread over hours sit at their real distance', () => {
    const hours = ['2026-10-21T10:00:00', '2026-10-21T10:30:00', '2026-10-21T12:00:00']
    const times = labelTimes(hours)!

    expect(positionOf(1, 3, times)).toBeCloseTo(0.25)

    const axis = xAxisOptions(hours, times, true, FixedScaleAxis)

    expect(times.map((time, index) => axis.labelInterpolationFnc?.(time, index))).toEqual(['10:00', '10:30', '12:00'])
  })

  test('labels the ticks of a span under a day with times, and a longer one with days', () => {
    const day = ['2026-10-21T00:00:00', '2026-10-21T23:59:00']
    const days = ['2026-10-21T00:00:00', '2026-10-22T00:00:00']
    const label = (labels: string[]) => xAxisOptions(labels, labelTimes(labels), true, FixedScaleAxis).labelInterpolationFnc?.(labelTimes(labels)![0]!, 0)

    expect(label(day)).toBe('00:00')
    expect(label(days)).toBe('21 Oct')
  })

  test('heads a date in full, its time only when it has one and its seconds only when points sit under a minute apart', () => {
    expect(headings(['2026-10-21', '2026-10-22'], null)).toEqual(['21 Oct 2026', '22 Oct 2026'])
    // Rendered with no window, as on the server, a time names the zone it is in.
    expect(headings(['2026-10-21T16:12:00', '2026-10-21T17:12:00'], null).map(text => text.replace(/ \S+$/, ''))).toEqual(['21 Oct 2026, 16:12', '21 Oct 2026, 17:12'])
    expect(headings(['2026-10-21T16:12:00', '2026-10-21T16:12:10'], null).map(text => text.replace(/ \S+$/, ''))).toEqual(['21 Oct 2026, 16:12:00', '21 Oct 2026, 16:12:10'])
    expect(headings(['Mon', '2026-10-21', 'Wed'], null)).toEqual(['Mon', '21 Oct 2026', 'Wed'])
    expect(headings([], null)).toEqual([])
  })

  test('hands an app\'s formatLabel the label and where it is drawn, for the tooltip and the ticks alike', () => {
    const seen: string[] = []
    const format = (label: string, context: LabelContext) => {
      seen.push(`${context.place}:${context.index}:${context.span}:${context.seconds}`)

      return `<${label}>`
    }
    const labels = ['2026-10-21T10:00:00', '2026-10-21T10:00:30', '2026-10-21T10:01:00']
    const times = labelTimes(labels)!

    expect(headings(labels, times, format)).toEqual(['<2026-10-21T10:00:00>', '<2026-10-21T10:00:30>', '<2026-10-21T10:01:00>'])

    const axis = xAxisOptions(labels, times, true, FixedScaleAxis, format)

    expect(times.map((time, index) => axis.labelInterpolationFnc?.(time, index))).toEqual(['<2026-10-21T10:00:00>', '<2026-10-21T10:00:30>', '<2026-10-21T10:01:00>'])
    expect(seen).toEqual(['tooltip:0:60000:true', 'tooltip:1:60000:true', 'tooltip:2:60000:true', 'tick:0:60000:true', 'tick:1:60000:true', 'tick:2:60000:true'])

    const plain = xAxisOptions(['a', 'b', 'c', 'd', 'e', 'f'], null, true, FixedScaleAxis, (label, { place }) => `${place}-${label}`)

    expect(plain.labelInterpolationFnc?.('a', 0)).toBe('tick-a')
    expect(plain.labelInterpolationFnc?.('c', 2)).toBeNull()
  })
})
