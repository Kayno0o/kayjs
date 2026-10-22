import { describe, expect, test } from 'bun:test'
import { monthStarts } from '../src/contribution'
import { stepIndex } from '../src/cycle'
import { isPlayable } from '../src/media'
import { pickedShown, selectionSummary, toggledValue } from '../src/multi-select'
import { axisExtent, axisPercent, barRatios, dashSample, dotSize, steppedPoint, valueTicks } from '../src/plot'
import { rangeFrom } from '../src/range'

const OPTIONS = [{ value: 'rpg', label: 'RPG' }, { value: 'fps', label: 'Shooter' }, { value: 'sim', label: 'Simulation' }]

describe('axes', () => {
  test('spans the domain when given, the values otherwise, and never an empty span', () => {
    expect(axisExtent([3, 9], {})).toEqual([3, 9])
    expect(axisExtent([3, 9], { domain: [0, 10] })).toEqual([0, 10])
    expect(axisExtent([], {})).toEqual([0, 1])
    expect(axisExtent([4, 4], {})).toEqual([4, 5])
    expect(axisExtent([1, 100], { scale: 'log' })).toEqual([0, 2])
  })

  test('places a value along the span, clamped to the plot, a log axis reading below 1 as 1', () => {
    expect(axisPercent(5, [0, 10])).toBe(50)
    expect(axisPercent(15, [0, 10])).toBe(100)
    expect(axisPercent(-2, [0, 10])).toBe(0)
    expect(axisPercent(10, [0, 2], 'log')).toBe(50)
    expect(axisPercent(0.2, [0, 2], 'log')).toBe(0)
  })

  test('sizes a dot by the square root of its weight against the heaviest', () => {
    expect(dotSize(0, 4)).toBe(0.625)
    expect(dotSize(4, 4)).toBe(1.75)
    expect(dotSize(1, 4)).toBeCloseTo(0.625 + 1.125 / 2)
  })

  test('samples a dashed line as a repeating gradient, a solid one as a plain colour', () => {
    expect(dashSample('red', '')).toBe('background-color: red')
    expect(dashSample('red', '10 3 2 3')).toBe('background-image: repeating-linear-gradient(90deg, red 0px 10px, transparent 10px 13px, red 13px 15px, transparent 15px 18px)')
  })

  test('steps a point along the line by key, clamped to its ends, and ignores other keys', () => {
    expect(steppedPoint('ArrowRight', 1, 3)).toBe(2)
    expect(steppedPoint('ArrowRight', 2, 3)).toBe(2)
    expect(steppedPoint('ArrowDown', 0, 3)).toBe(0)
    expect(steppedPoint('Home', 2, 3)).toBe(0)
    expect(steppedPoint('End', 0, 3)).toBe(2)
    expect(steppedPoint('End', 0, 0)).toBe(0)
    expect(steppedPoint('a', 1, 3)).toBeUndefined()
  })
})

describe('MultiSelect helpers', () => {
  test('reads the placeholder, the single label, or a count', () => {
    expect(selectionSummary(OPTIONS, [], 'Any genre')).toBe('Any genre')
    expect(selectionSummary(OPTIONS, ['fps'], 'Any genre')).toBe('Shooter')
    expect(selectionSummary(OPTIONS, ['gone'], 'Any genre')).toBe('gone')
    expect(selectionSummary(OPTIONS, ['fps', 'rpg'], 'Any genre')).toBe('2 selected')
  })

  test('flips a value, keeping the options\' order and values no option names', () => {
    expect(toggledValue(OPTIONS, ['sim'], 'rpg')).toEqual(['rpg', 'sim'])
    expect(toggledValue(OPTIONS, ['rpg', 'sim'], 'rpg')).toEqual(['sim'])
    expect(toggledValue(OPTIONS, ['gone'], 'fps')).toEqual(['fps', 'gone'])
  })

  test('picks or drops the shown options alone, in the options\' order, keeping values no option names', () => {
    expect(pickedShown(OPTIONS, ['gone', 'sim'], [OPTIONS[0]!, OPTIONS[1]!], true)).toEqual(['rpg', 'fps', 'sim', 'gone'])
    expect(pickedShown(OPTIONS, ['rpg', 'sim', 'gone'], [OPTIONS[0]!], false)).toEqual(['sim', 'gone'])
  })
})

describe('RangeInput bounds', () => {
  test('reads an empty or unparsable box as open, and puts a reversed pair in order', () => {
    expect(rangeFrom('', ' ')).toEqual([null, null])
    expect(rangeFrom('2', 'abc')).toEqual([2, null])
    expect(rangeFrom('10', '3')).toEqual([3, 10])
    expect(rangeFrom('0', '0')).toEqual([0, 0])
  })
})

describe('monthStarts', () => {
  const weeks = (from: string, count: number) => Array.from({ length: count * 7 }, (_, index) => new Date(Date.parse(`${from}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10))

  test('labels the column each month starts in, dropping one too close to the next', () => {
    expect(monthStarts(weeks('2026-01-26', 10)).map(start => start.column)).toEqual([0, 4, 9])
    expect(monthStarts(weeks('2026-01-05', 10)).map(start => start.column)).toEqual([0, 3, 7])
  })
})

describe('media', () => {
  test('wraps a step around both ends', () => {
    expect(stepIndex(0, -1, 3)).toBe(2)
    expect(stepIndex(2, 1, 3)).toBe(0)
    expect(stepIndex(1, 0, 3)).toBe(1)
    expect(stepIndex(4, 0, 0)).toBe(0)
  })

  test('plays only a video that has a source', () => {
    const item = { key: 1, thumb: 't', preview: 'p' }

    expect(isPlayable({ ...item, kind: 'video', src: 'a.m3u8' })).toBe(true)
    expect(isPlayable({ ...item, kind: 'video' })).toBe(false)
    expect(isPlayable({ ...item, kind: 'image', src: 'a.jpg' })).toBe(false)
  })
})

describe('barRatios', () => {
  test('sets each bar against the highest reading, and a stacked bar against the highest total', () => {
    expect(barRatios([[2, 4], [1, null]], false, 2)).toEqual({ heights: [[0.5, 1], [0.25, 0]], top: 4 })
    expect(barRatios([[2, 4], [1, null]], true, 2)).toEqual({ heights: [[2 / 4, 4 / 4], [1 / 4, 0]], top: 4 })
    expect(barRatios([[1, 1], [2, 1]], true, 2).top).toBe(4)
  })

  test('rounds the top up to 1, 2, 4, 6, 8 or 10 times a power of ten, so the middle tick is round', () => {
    const top = (value: number) => barRatios([[value]], false, 1).top

    expect([1, 2, 3, 5, 7, 9, 31, 99, 100, 101, 1234].map(top)).toEqual([1, 2, 4, 6, 8, 10, 40, 100, 100, 200, 2000])
    expect([0.03, 0.7, 0.15].map(top)).toEqual([0.04, 0.8, 0.2])
    expect(barRatios([[31]], false, 1).heights).toEqual([[31 / 40]])
    expect(valueTicks(40).map(tick => tick.ratio * 40)).toEqual([0, 20, 40])
  })

  test('draws no bar for a gap, a zero or a negative reading', () => {
    expect(barRatios([[null, 0, -3, Number.NaN]], false, 4)).toEqual({ heights: [[0, 0, 0, 0]], top: 0 })
    expect(valueTicks(0)).toEqual([{ ratio: 0 }])
    expect(valueTicks(5).map(tick => tick.ratio)).toEqual([0, 0.5, 1])
  })
})
