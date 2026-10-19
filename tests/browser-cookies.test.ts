import { existsSync } from 'node:fs'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { browse, browserPath, testSite } from '../src/test'
import { cookiePairs } from '../src/test/browser'

const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

describe('cookiePairs', () => {
  it('splits a Cookie header, trimming and skipping empty or nameless pieces', () => {
    expect(cookiePairs('a=1; b=2;  ;c;=x;')).toEqual([{ name: 'a', value: '1' }, { name: 'b', value: '2' }])
  })

  it('keeps everything after the first equals sign in a value', () => {
    expect(cookiePairs('token=abc==; k=a=b=c')).toEqual([{ name: 'token', value: 'abc==' }, { name: 'k', value: 'a=b=c' }])
  })

  it('passes a list through', () => {
    expect(cookiePairs([{ name: 'a', value: '1' }])).toEqual([{ name: 'a', value: '1' }])
    expect(cookiePairs(undefined)).toEqual([])
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('browse with cookies', () => {
  const server = Bun.serve({ port: 0, fetch: request => new Response(`<!doctype html><title>t</title><p id="c">${request.headers.get('cookie') ?? 'none'}</p>`, { headers: { 'content-type': 'text/html' } }) })

  afterAll(async () => server.stop(true))

  it('carries a Cookie header string or a list on the first load, and none on a later page', async () => {
    const url = String(server.url)
    const fromString = await browse(url, { path, cookies: 'a=1; b=x=y' })

    try {
      expect((await fromString.text('#c'))?.split('; ').sort()).toEqual(['a=1', 'b=x=y'])
    }
    finally {
      fromString.close()
    }

    const fromList = await browse(url, { path, cookies: [{ name: 'c', value: '3' }] })

    try {
      expect(await fromList.text('#c')).toBe('c=3')
    }
    finally {
      fromList.close()
    }

    const stranger = await browse(url, { path })

    try {
      expect(await stranger.text('#c')).toBe('none')
    }
    finally {
      stranger.close()
    }
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('site.as(cookie).open', () => {
  it('signs the browser in with the cookie it was made with', async () => {
    const site = await testSite({ routes: 'tests/fixtures/base-site/src/routes', api: 'tests/fixtures/base-site/src/api', browser: { path } })

    try {
      const page = await site.as('session=abc').open('/api/cookies/read')

      expect(await page.text('body')).toBe('session=abc')
    }
    finally {
      await site.close()
    }
  }, 60_000)
})
