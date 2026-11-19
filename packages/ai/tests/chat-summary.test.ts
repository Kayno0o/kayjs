import { expect, test } from 'bun:test'
import { inputSummary } from '../src/chat-summary'

test('says a call input as one line of key: value, not JSON', () => {
  expect(inputSummary({ query: 'refund policy', limit: 3 })).toBe('query: "refund policy", limit: 3')
  expect(inputSummary({})).toBe('')
  expect(inputSummary(undefined)).toBe('')
  expect(inputSummary('milk')).toBe('milk')
})

test('cuts a long input at 80 characters', () => {
  const line = inputSummary({ body: 'x'.repeat(200) })

  expect(line).toHaveLength(80)
  expect(line.endsWith('…')).toBe(true)
})
