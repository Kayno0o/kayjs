import { describe, expect, test } from 'bun:test'
import { isCurrentTab, keptHref } from '../src/tab-nav'

describe('keptHref', () => {
  const current = new URL('https://example.com/traffic/bots?period=7d&site=a&site=b&page=3')

  test('carries the named params of the current URL, every value of each, and no other', () => {
    expect(keptHref('/traffic', current, ['period', 'site'])).toBe('/traffic?period=7d&site=a&site=b')
    expect(keptHref('/traffic', current, [])).toBe('/traffic')
    expect(keptHref('/traffic', current, ['missing'])).toBe('/traffic')
  })

  test('leaves a param the link sets itself, and keeps its hash after the query', () => {
    expect(keptHref('/traffic?period=30d#chart', current, ['period', 'site'])).toBe('/traffic?period=30d&site=a&site=b#chart')
  })

  test('reads the params from a string current too, and encodes what it carries', () => {
    expect(keptHref('/search', '/traffic?q=a%26b c', ['q'])).toBe('/search?q=a%26b+c')
  })
})

describe('isCurrentTab', () => {
  test('matches a string current as written', () => {
    expect(isCurrentTab('/settings', '/settings')).toBe(true)
    expect(isCurrentTab('/settings', '/settings?tab=1')).toBe(false)
  })

  test('matches a URL by its path and the params the link sets', () => {
    const current = new URL('https://example.com/traffic?period=7d&view=table')

    expect(isCurrentTab('/traffic', current)).toBe(true)
    expect(isCurrentTab('/traffic?view=table', current)).toBe(true)
    expect(isCurrentTab('/traffic?view=chart', current)).toBe(false)
    expect(isCurrentTab('/traffic/sites', current)).toBe(false)
  })
})
