import { expect, it } from 'bun:test'
import { resetEachTest } from '../src/test/reset'

let cleared = 0

resetEachTest(() => void cleared++)

it('clears when called and before the test', () => {
  expect(cleared).toBe(2)
})

it('clears after each test and before the next', () => {
  expect(cleared).toBe(4)
})

it('runs once, with no hook, inside a test', () => {
  const before = cleared

  resetEachTest(() => void cleared++)

  expect(cleared).toBe(before + 1)
})
