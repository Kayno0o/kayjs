import type { Column } from '../src/table'
import { describe, expect, test } from 'bun:test'
import { cellText, nextSort, rowKeyOf, sortedRows } from '../src/table'

interface Planet { id: number, name: string, moons: number | null }

const planets: Planet[] = [{ id: 1, name: 'Mars', moons: 2 }, { id: 2, name: 'Earth', moons: 1 }, { id: 3, name: 'Venus', moons: null }]
const name: Column<Planet> = { key: 'name', header: 'Name', sortValue: true }
const moons: Column<Planet> = { key: 'moons', header: 'Moons', sortValue: planet => planet.moons ?? -1, defaultDirection: 'asc' }

describe('sortedRows', () => {
  test('sorts by the row\'s own value or the column\'s function, either way', () => {
    expect(sortedRows(planets, [name, moons], { key: 'name', direction: 'asc' }).map(planet => planet.name)).toEqual(['Earth', 'Mars', 'Venus'])
    expect(sortedRows(planets, [name, moons], { key: 'moons', direction: 'desc' }).map(planet => planet.name)).toEqual(['Mars', 'Earth', 'Venus'])
  })

  test('leaves the rows as they came for no sort, or a column that cannot sort', () => {
    expect(sortedRows(planets, [name], undefined)).toBe(planets)
    expect(sortedRows(planets, [{ key: 'id', header: 'Id' }], { key: 'id', direction: 'asc' })).toBe(planets)
  })
})

test('nextSort flips a sorted column and starts another on its default direction', () => {
  expect(nextSort({ key: 'name', direction: 'desc' }, name)).toEqual({ key: 'name', direction: 'asc' })
  expect(nextSort({ key: 'name', direction: 'desc' }, moons)).toEqual({ key: 'moons', direction: 'asc' })
  expect(nextSort(undefined, name)).toEqual({ key: 'name', direction: 'desc' })
})

test('cellText shows nothing for a missing value, and rowKeyOf reads a field or calls a function', () => {
  expect(cellText(planets[2]!, moons)).toBe('')
  expect(cellText(planets[0]!, moons)).toBe('2')
  expect(rowKeyOf(planets[0]!, 'id')).toBe(1)
  expect(rowKeyOf(planets[0]!, planet => planet.name)).toBe('Mars')
})
