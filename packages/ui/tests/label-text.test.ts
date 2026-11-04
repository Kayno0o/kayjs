import { expect, test } from 'bun:test'
import { labelText } from '../src/label-text'

test('a string fills the placeholders it names and leaves an unknown one as written', () => {
  expect(labelText('{count} more of {kind}', { count: 3 })).toBe('3 more of {kind}')
  expect(labelText('Remove row', {})).toBe('Remove row')
})

test('a function is called with the arguments and the values are ignored', () => {
  expect(labelText((count: number, kind: string) => `${count} ${kind}`, { count: 9 }, 2, 'rows')).toBe('2 rows')
})
