import { describe, expect, test } from 'bun:test'
import { currentTab, keptHref } from '../src/tab-nav'

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

describe('currentTab', () => {
  test('matches a string current as written', () => {
    expect(currentTab(['/settings', '/settings/keys'], '/settings')).toBe('/settings')
    expect(currentTab(['/settings'], '/settings?tab=1')).toBeUndefined()
  })

  test('matches a URL by its path and the params the link sets, the link setting the most winning', () => {
    const current = new URL('https://example.com/traffic?period=7d&view=table')

    expect(currentTab(['/traffic', '/traffic/sites'], current)).toBe('/traffic')
    expect(currentTab(['/traffic', '/traffic?view=table', '/traffic?view=chart'], current)).toBe('/traffic?view=table')
    expect(currentTab(['/traffic?view=chart', '/traffic/sites'], current)).toBeUndefined()
  })
})
