import { describe, expect, it } from 'bun:test'
import { unnamedHeaders } from '../src/build/header-files'

const MINE = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': 'default-src \'self\'', 'Referrer-Policy': 'no-referrer' }

describe('unnamedHeaders', () => {
  it('drops a header the app names for every path, whatever its spelling', () => {
    expect(unnamedHeaders(MINE, '/*\n  x-frame-options: SAMEORIGIN\n')).toEqual({ 'Content-Security-Policy': 'default-src \'self\'', 'Referrer-Policy': 'no-referrer' })
  })

  it('reads past a comment line between the rule and its headers', () => {
    expect(unnamedHeaders(MINE, '/*\n# one policy for all\n  X-Frame-Options: DENY\n')).toEqual({ 'Content-Security-Policy': 'default-src \'self\'', 'Referrer-Policy': 'no-referrer' })
  })

  it('keeps a header the app names under another path alone, as it does not reach the rest of the site', () => {
    expect(unnamedHeaders(MINE, '/embed/*\n  X-Frame-Options: ALLOWALL\n  Content-Security-Policy: frame-ancestors *\n\n/*\n  X-Mine: yes\n')).toEqual(MINE)
    expect(unnamedHeaders(MINE, '/*\n  X-Mine: yes\n\n/embed/*\n  Referrer-Policy: origin\n')).toEqual(MINE)
  })
})
