import { describe, expect, it } from 'bun:test'
import { failedTests } from '../scripts/test-failures'

const ERROR = ['270 |     expect(lifetimes).toEqual([30 * DAY, 90 * DAY])', 'error: expect(received).toEqual(expected)', '      at <anonymous> (tests/session.test.ts:270:23)']

describe('failed tests in a bun test run', () => {
  it('takes each one\'s output since the test before it, once, as a parallel run prints it locally', () => {
    const lines = ['tests/session.test.ts:', '(pass) sessions > forgets [51.46ms]', ...ERROR, '(fail) sessions > ends after 90 days [11.26ms]', '', 'tests/dom.test.ts:', 'a warning of its own', '(fail) dom > swaps [2.00ms]', '', '2 tests failed:', '(fail) sessions > ends after 90 days [11.26ms]', '(fail) dom > swaps [2.00ms]']

    expect(failedTests(lines)).toEqual([[...ERROR, '(fail) sessions > ends after 90 days [11.26ms]'].join('\n'), 'a warning of its own\n(fail) dom > swaps [2.00ms]'])
  })

  it('stops at a file\'s group and leaves the annotations out, as CI prints them', () => {
    const lines = ['::group::tests/session.test.ts:', ...ERROR, '::error file=tests/session.test.ts,line=270::expected', '(fail) sessions > ends after 90 days [11.26ms]', '::endgroup::']

    expect(failedTests(lines)).toEqual([[...ERROR, '(fail) sessions > ends after 90 days [11.26ms]'].join('\n')])
  })

  it('shows ten and counts the rest', () => {
    const lines = Array.from({ length: 12 }, (_, index) => `(fail) test ${index}`)

    expect(failedTests(lines)).toEqual([...lines.slice(0, 10), 'and 2 more failed tests'])
  })
})
