import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { redirectMovedPage, removeRuntimeRedirect, runtimeRedirects } from '../src/server/library'
import { knowRuntimeRules } from '../src/server/runtime-redirect-api'
import { pages } from './shared-pages'

const paths = ['/fr/mp-a', '/mp-a', '/mp-b', '/mp-c', '/mp-old', '/mp-new']

beforeEach(async () => {
  knowRuntimeRules({ redirects: {} })
})

afterEach(async () => {
  for (const path of paths)
    await removeRuntimeRedirect(path)

  knowRuntimeRules({ redirects: {} })
})

async function rows() {
  return (await runtimeRedirects()).filter(row => row.from.includes('mp-')).map(row => [row.from, row.to]).sort()
}

describe('redirecting the page an entry moved from', () => {
  it('redirects the old page to the new one, per locale, whatever the trailing slash', async () => {
    await redirectMovedPage('/mp-old/', '/mp-new/')
    await redirectMovedPage('/fr/mp-a', '/fr/mp-b')

    expect(await rows()).toEqual([['/fr/mp-a', '/fr/mp-b'], ['/mp-old', '/mp-new/']])
  })

  it('takes the base off both pages, and skips a page outside it or on another site', async () => {
    knowRuntimeRules({ redirects: {}, base: '/docs' })
    await redirectMovedPage('/docs/mp-a', '/docs/mp-b')
    await redirectMovedPage('/mp-old', '/docs/mp-new')
    await redirectMovedPage('/docs/mp-old', 'https://example.org/docs/mp-new')
    await redirectMovedPage('/docs/mp-c', undefined)
    await redirectMovedPage(undefined, '/docs/mp-c')

    expect(await rows()).toEqual([['/mp-a', '/mp-b']])
  })

  it('does nothing when the path stays', async () => {
    await redirectMovedPage('/mp-a', '/mp-a/')
    expect(await rows()).toEqual([])
  })

  it('keeps a chain of two moves at one hop', async () => {
    await redirectMovedPage('/mp-a', '/mp-b')
    await redirectMovedPage('/mp-b', '/mp-c')

    expect(await rows()).toEqual([['/mp-a', '/mp-c'], ['/mp-b', '/mp-c']])
  })

  it('moving back removes the redirect from the page that exists again, and makes no loop', async () => {
    await redirectMovedPage('/mp-a', '/mp-b')
    await redirectMovedPage('/mp-b', '/mp-a')
    expect(await rows()).toEqual([['/mp-b', '/mp-a']])

    await redirectMovedPage('/mp-a', '/mp-b')
    await redirectMovedPage('/mp-b', '/mp-c')
    await redirectMovedPage('/mp-c', '/mp-a')
    expect(await rows()).toEqual([['/mp-b', '/mp-a'], ['/mp-c', '/mp-a']])
  })

  it('refuses what a redirect refuses', async () => {
    await expect(redirectMovedPage('/mp-a b', '/mp-b')).rejects.toThrow()
    await expect(redirectMovedPage('/mp-a', '/mp-b\r\nx: y')).rejects.toThrow()
    expect(await rows()).toEqual([])
  })

  it('answers the old page 404 with the redirect under a base and a trailing slash', async () => {
    const served = new Elysia().use(await pages({ root: 'tests/fixtures/routing', prebuilt: false, security: false, base: '/app', trailingSlash: 'always' }))

    await redirectMovedPage('/app/mp-old/', '/app/bare/')

    const response = await served.handle(new Request('http://localhost/mp-old/?x=1'))

    expect([response.status, response.headers.get('location')]).toEqual([307, '/app/bare/?x=1'])
  })
})
