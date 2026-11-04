import { describe, expect, it } from 'bun:test'
import { TAKE_COOKIES } from '../src/request'
import { sendCookies } from '../src/routes'

const context = (headers: Record<string, unknown>, responseValue?: Response, cookies = ['kay_session=a; Path=/; HttpOnly']) => ({ auth: { [TAKE_COOKIES]: () => cookies }, set: { headers }, responseValue })

describe('the cookies a sign-in or a sign-out sends', () => {
  it('make a public plain answer private, on the context\'s headers', () => {
    const given = context({ 'cache-control': 'public, max-age=60' })

    sendCookies(given)
    expect(given.set.headers['set-cookie']).toEqual(['kay_session=a; Path=/; HttpOnly'])
    expect(given.set.headers['cache-control']).toBe('private, no-cache')
  })

  it('make a public Response private, a sign-out clearing the cookie included', () => {
    for (const cookie of ['kay_session=a; Path=/', 'kay_session=; Max-Age=0; Path=/']) {
      const response = new Response('ok', { headers: { 'cache-control': 'public, s-maxage=60' } })

      sendCookies(context({}, response, [cookie]))
      expect(response.headers.get('set-cookie')).toBe(cookie)
      expect(response.headers.get('cache-control')).toBe('private, no-cache')
    }
  })

  it('leave an answer that sets no cookie alone', () => {
    const given = context({ 'cache-control': 'public, max-age=60' }, undefined, [])

    sendCookies(given)
    expect(given.set.headers['cache-control']).toBe('public, max-age=60')
  })
})
