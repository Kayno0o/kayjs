import { describe, expect, test } from 'bun:test'
import { shade } from '../src/shade'

describe('shade', () => {
  test('leaves an empty day unfilled', () => {
    expect(shade('red', 0)).toBeUndefined()
  })

  test('starts just above a quarter of the colour, so any activity shows', () => {
    expect(shade('red', 0.01)).toBe('color-mix(in srgb, red 26%, transparent)')
  })

  test('caps an overfull day at the full colour', () => {
    expect(shade('var(--accent)', 3)).toBe('color-mix(in srgb, var(--accent) 100%, transparent)')
  })
})
