import { expect, test } from 'bun:test'
import { followedRow } from '../src/followed-row'

test('the row a block gets is a view of the current one: read by key it follows a replacement, compared by identity it is not the row', () => {
  const row = { id: 1, days: '2' }
  let rows = [row]
  const view = followedRow(() => rows[0], seen => seen)

  expect(view.days).toBe('2')
  expect({ ...view }).toEqual({ id: 1, days: '2' })

  rows = [{ id: 1, days: '9' }]
  expect(view.days).toBe('9')
  expect(rows.indexOf(view)).toBe(-1)
  expect(rows.findIndex(item => item.id === view.id)).toBe(0)
})

test('a row that is not an object is passed as it is', () => {
  expect(followedRow(() => 'text', seen => seen)).toBe('text')
})
