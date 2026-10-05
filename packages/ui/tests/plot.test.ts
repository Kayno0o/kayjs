import { describe, expect, test } from 'bun:test'
import { monthStarts } from '../src/contribution'
import { selectionSummary, toggledValue } from '../src/multi-select'
import { axisExtent, axisPercent, dotSize } from '../src/plot'
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
