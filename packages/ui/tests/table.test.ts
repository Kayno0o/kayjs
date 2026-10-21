import type { Column } from '../src/table'
import { describe, expect, test } from 'bun:test'
import { cellText, csvField, drawnByBlock, exportHref, nextSort, resolvedColumn, rowKeyOf, rowLabel, rowsMatching, sortedRows, toCsv } from '../src/table'

interface Planet { id: number, name: string, moons: number | null }

const planets: Planet[] = [{ id: 1, name: 'Mars', moons: 2 }, { id: 2, name: 'Earth', moons: 1 }, { id: 3, name: 'Venus', moons: null }]
const name: Column<Planet> = { key: 'name', header: 'Name', sortValue: true }
const moons: Column<Planet> = { key: 'moons', header: 'Moons', sortValue: planet => planet.moons ?? -1, defaultDirection: 'asc' }

describe('sortedRows', () => {
  test('sorts by the row\'s own value or the column\'s function, either way', () => {
    expect(sortedRows(planets, [name, moons], { key: 'name', direction: 'asc' }).map(planet => planet.name)).toEqual(['Earth', 'Mars', 'Venus'])
    expect(sortedRows(planets, [name, moons], { key: 'moons', direction: 'desc' }).map(planet => planet.name)).toEqual(['Mars', 'Earth', 'Venus'])
  })

  test('reads each row\'s sort value once', () => {
    let reads = 0
    const counted: Column<Planet> = { key: 'moons', header: 'Moons', sortValue: (planet) => {
      reads++

      return planet.moons ?? -1
    } }

    sortedRows(planets, [counted], { key: 'moons', direction: 'asc' })

    expect(reads).toBe(planets.length)
  })

  test('leaves the rows as they came for no sort, or a column that cannot sort', () => {
    expect(sortedRows(planets, [name], undefined)).toBe(planets)
    expect(sortedRows(planets, [{ key: 'id', header: 'Id' }], { key: 'id', direction: 'asc' })).toBe(planets)
  })
})

test('sortValue: true sorts dates by time and booleans as numbers, and missing values last either way', () => {
  interface Launch { name: string, at: Date | null, crewed: boolean }

  const launches: Launch[] = [
    { name: 'Gemini', at: new Date('1965-03-23'), crewed: true },
    { name: 'Sputnik', at: null, crewed: false },
    { name: 'Apollo', at: new Date('1968-10-11'), crewed: true },
    { name: 'Luna', at: new Date('1959-01-02'), crewed: false },
  ]
  const at: Column<Launch> = { key: 'at', header: 'At', sortValue: true }
  const crewed: Column<Launch> = { key: 'crewed', header: 'Crewed', sortValue: true }
  const names = (sort: Parameters<typeof sortedRows>[2]) => sortedRows(launches, [at, crewed], sort).map(launch => launch.name)

  expect(names({ key: 'at', direction: 'asc' })).toEqual(['Luna', 'Gemini', 'Apollo', 'Sputnik'])
  expect(names({ key: 'at', direction: 'desc' })).toEqual(['Apollo', 'Gemini', 'Luna', 'Sputnik'])
  expect(names({ key: 'crewed', direction: 'desc' })).toEqual(['Gemini', 'Apollo', 'Sputnik', 'Luna'])
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

test('a numeric column aligns to the end and sorts by its own value, largest first, unless it says otherwise', () => {
  expect(resolvedColumn<Planet>({ key: 'moons', header: 'Moons', numeric: true })).toEqual({ key: 'moons', header: 'Moons', numeric: true, align: 'end', sortValue: true, defaultDirection: 'desc' })
  expect(resolvedColumn<Planet>({ key: 'moons', header: 'Moons', numeric: true, defaultDirection: 'asc' }).defaultDirection).toBe('asc')
  expect(resolvedColumn(name)).toBe(name)
})

test('the @cell block draws every column but a cell: false one, or only the cell: true ones once a column sets it', () => {
  const plain: Column<Planet>[] = [name, { ...moons, cell: false }]
  const marked: Column<Planet>[] = [{ ...name, cell: true }, moons]

  expect(plain.map(column => drawnByBlock(column, plain))).toEqual([true, false])
  expect(marked.map(column => drawnByBlock(column, marked))).toEqual([true, false])
})

test('a filter keeps a row whose fields or function values hold the text, its case and spaces ignored', () => {
  expect(rowsMatching(planets, ['name'], ' AR ').map(planet => planet.name)).toEqual(['Mars', 'Earth'])
  expect(rowsMatching(planets, row => [row.name, row.moons], '2').map(planet => planet.name)).toEqual(['Mars'])
  expect(rowsMatching(planets, ['moons'], '')).toBe(planets)
})

test('rowLabel names a row by its first column with any text, or its key', () => {
  expect(rowLabel(planets[0]!, [name, moons], 'id')).toBe('Mars')
  expect(rowLabel({ id: 4, name: '', moons: null }, [name, moons], 'id')).toBe('4')
  expect(rowLabel({ id: 4, name: '', moons: 7 }, [name, moons], row => `p${row.id}`)).toBe('7')
})

describe('toCsv', () => {
  const columns: Column<Planet>[] = [name, moons, { key: 'id', header: 'Id' }]

  test('writes the headers and each row\'s own values with CRLF line ends and a byte order mark', () => {
    expect(toCsv(planets, columns)).toBe('﻿Name,Moons,Id\r\nMars,2,1\r\nEarth,1,2\r\nVenus,,3\r\n')
  })

  test('quotes a field holding a comma, a quote or a line break', () => {
    expect(csvField('a, b')).toBe('"a, b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('one\ntwo')).toBe('"one\ntwo"')
  })

  test('escapes a text a spreadsheet would run as a formula, and leaves a negative number alone', () => {
    for (const text of ['=SUM(A1)', '+1', '-1', '@cmd', '\tx', '\rx'])
      expect(csvField(text)).toBe(csvField(`'${text}`))

    expect(csvField('=1+1')).toBe('\'=1+1')
    expect(csvField('=HYPERLINK("x","y")')).toBe('"\'=HYPERLINK(""x"",""y"")"')
    expect(csvField(-5)).toBe('-5')
    expect(toCsv([{ id: 1, name: '=cmd', moons: -2 }], columns)).toBe('﻿Name,Moons,Id\r\n\'=cmd,-2,1\r\n')
    expect(toCsv([], [{ key: 'a', header: '=bad' }])).toBe('﻿\'=bad\r\n')
  })

  test('writes dates as ISO text and booleans and missing values plainly', () => {
    expect(csvField(new Date(0))).toBe('1970-01-01T00:00:00.000Z')
    expect(csvField(new Date(Number.NaN))).toBe('')
    expect(csvField(true)).toBe('true')
    expect(csvField(null)).toBe('')
    expect(csvField(undefined)).toBe('')
  })
})

describe('exportHref', () => {
  test('adds the sort and the typed text to the address, keeping the query and hash it has', () => {
    expect(exportHref('/planets.csv', { key: 'moons', direction: 'desc' }, 'q', 'ma rs')).toBe('/planets.csv?sort=moons&direction=desc&q=ma+rs')
    expect(exportHref('/planets.csv?team=a#top', undefined, 'q', '  ')).toBe('/planets.csv?team=a#top')
    expect(exportHref('/p.csv?next=/a?b', undefined, 'q', 'x')).toBe('/p.csv?next=%2Fa%3Fb&q=x')
    expect(exportHref('/planets.csv?q=old', undefined, 'q', 'new')).toBe('/planets.csv?q=new')
  })
})
