import { expect, test } from 'bun:test'
import { darkStyle } from '../src/dark'
import defaults from '../src/defaults'

test('the dark style is built once per settings', () => {
  expect(darkStyle(defaults)).toBe(darkStyle(defaults))
  expect(darkStyle({ ...defaults })).not.toBe(darkStyle(defaults))
})
