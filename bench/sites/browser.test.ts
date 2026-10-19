import { describe, expect, it } from 'bun:test'
import { browserAuth } from './browser'

describe('browserAuth', () => {
  it('sets a cookie header as the origin\'s cookies, a value holding = whole, and sends the rest as headers', () => {
    expect(browserAuth({ Cookie: 'session=a=b; theme=dark;', authorization: 'Bearer t' }, 'https://localhost:47441')).toEqual({
      cookies: [{ name: 'session', value: 'a=b', url: 'https://localhost:47441' }, { name: 'theme', value: 'dark', url: 'https://localhost:47441' }],
      headers: { authorization: 'Bearer t' },
    })
    expect(browserAuth({}, 'https://localhost:47441')).toEqual({ cookies: [], headers: {} })
  })
})
