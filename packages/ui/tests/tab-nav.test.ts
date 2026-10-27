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

const links = (...hrefs: string[]) => hrefs.map(href => ({ href }))

describe('currentTab', () => {
  test('matches a string current as written', () => {
    expect(currentTab(links('/settings', '/settings/keys'), '/settings')).toBe('/settings')
    expect(currentTab(links('/settings'), '/settings?tab=1')).toBeUndefined()
  })

  test('matches a URL by its path and the params the link sets, the link setting the most winning', () => {
    const current = new URL('https://example.com/traffic?period=7d&view=table')

    expect(currentTab(links('/traffic', '/traffic/sites'), current)).toBe('/traffic')
    expect(currentTab(links('/traffic', '/traffic?view=table', '/traffic?view=chart'), current)).toBe('/traffic?view=table')
    expect(currentTab(links('/traffic?view=chart', '/traffic/sites'), current)).toBeUndefined()
  })

  test('marks a link current on the pages under its path with prefix, or under the paths in also, the exact page winning', () => {
    const tabs = [{ href: '/traffic', prefix: true }, { href: '/traffic/errors', prefix: true }, { href: '/logs', also: ['/logs/archive/'] }, { href: '/other' }]
    const at = (path: string) => currentTab(tabs, new URL(path, 'https://example.com'))

    expect(at('/traffic')).toBe('/traffic')
    expect(at('/traffic/requests/12?period=7d')).toBe('/traffic')
    expect(at('/traffic/errors/4')).toBe('/traffic/errors')
    expect(at('/traffic/errors')).toBe('/traffic/errors')
    expect(at('/trafficking')).toBeUndefined()
    expect(at('/logs/archive')).toBe('/logs')
    expect(at('/logs/archive/2024/1')).toBe('/logs')
    expect(at('/logs/live')).toBeUndefined()
    expect(at('/other/deep')).toBeUndefined()
  })

  test('keeps a string current exact whatever a link\'s prefix says', () => {
    expect(currentTab([{ href: '/traffic', prefix: true }], '/traffic/requests/12')).toBeUndefined()
  })
})
