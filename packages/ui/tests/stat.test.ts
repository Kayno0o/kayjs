import { expect, test } from 'bun:test'
import { deltaIcon } from '../src/stat'

test('the arrow of a change follows the sign of its value, and `direction` has the last word', () => {
  expect(['+12%', '-3', '−3', '0%', '12%', ' +1'].map(value => deltaIcon({ value }))).toEqual(['trendUp', 'trendDown', 'trendDown', 'trendFlat', 'trendFlat', 'trendUp'])
  expect([deltaIcon({ value: '+2', direction: 'down' }), deltaIcon({ value: '5', direction: 'up' }), deltaIcon({ value: '-1', direction: 'flat' })]).toEqual(['trendDown', 'trendUp', 'trendFlat'])
})
