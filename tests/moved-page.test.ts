import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from '../src/server'
import { redirectMovedPage, removeRuntimeRedirect, runtimeRedirects } from '../src/server/library'
import { knowRuntimeRules } from '../src/server/runtime-redirect-api'

const paths = ['/fr/mp-a', '/mp-a', '/mp-b', '/mp-c', '/mp-old', '/mp-new']

beforeEach(() => {
  knowRuntimeRules({ redirects: {} })
})

afterEach(() => {
  for (const path of paths)
    removeRuntimeRedirect(path)

  knowRuntimeRules({ redirects: {} })
})

function rows() {
  return runtimeRedirects().filter(row => row.from.includes('mp-')).map(row => [row.from, row.to]).sort()
}

describe('redirecting the page an entry moved from', () => {
  it('redirects the old page to the new one, per locale, whatever the trailing slash', () => {
    redirectMovedPage('/mp-old/', '/mp-new/')
    redirectMovedPage('/fr/mp-a', '/fr/mp-b')

    expect(rows()).toEqual([['/fr/mp-a', '/fr/mp-b'], ['/mp-old', '/mp-new/']])
  })

  it('takes the base off both pages, and skips a page outside it or on another site', () => {
    knowRuntimeRules({ redirects: {}, base: '/docs' })
    redirectMovedPage('/docs/mp-a', '/docs/mp-b')
    redirectMovedPage('/mp-old', '/docs/mp-new')
    redirectMovedPage('/docs/mp-old', 'https://example.org/docs/mp-new')
    redirectMovedPage('/docs/mp-c', undefined)
    redirectMovedPage(undefined, '/docs/mp-c')

    expect(rows()).toEqual([['/mp-a', '/mp-b']])
  })

  it('does nothing when the path stays', () => {
    redirectMovedPage('/mp-a', '/mp-a/')
    expect(rows()).toEqual([])
  })

  it('keeps a chain of two moves at one hop', () => {
    redirectMovedPage('/mp-a', '/mp-b')
    redirectMovedPage('/mp-b', '/mp-c')

    expect(rows()).toEqual([['/mp-a', '/mp-c'], ['/mp-b', '/mp-c']])
  })

  it('moving back removes the redirect from the page that exists again, and makes no loop', () => {
    redirectMovedPage('/mp-a', '/mp-b')
    redirectMovedPage('/mp-b', '/mp-a')
    expect(rows()).toEqual([['/mp-b', '/mp-a']])

    redirectMovedPage('/mp-a', '/mp-b')
    redirectMovedPage('/mp-b', '/mp-c')
    redirectMovedPage('/mp-c', '/mp-a')
    expect(rows()).toEqual([['/mp-b', '/mp-a'], ['/mp-c', '/mp-a']])
  })

  it('refuses what a redirect refuses', () => {
    expect(() => redirectMovedPage('/mp-a b', '/mp-b')).toThrow()
    expect(() => redirectMovedPage('/mp-a', '/mp-b\r\nx: y')).toThrow()
    expect(rows()).toEqual([])
  })

  it('answers the old page 404 with the redirect under a base and a trailing slash', async () => {
    const served = new Elysia().use(await pages({ routes: 'tests/fixtures/routing/src/routes', prebuilt: false, security: false, base: '/app', trailingSlash: 'always' }))

    redirectMovedPage('/app/mp-old/', '/app/bare/')

    const response = await served.handle(new Request('http://localhost/mp-old/?x=1'))

    expect([response.status, response.headers.get('location')]).toEqual([307, '/app/bare/?x=1'])
  })
})
