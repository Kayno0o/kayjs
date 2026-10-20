import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { browse, browserPath, testSite } from '../src/test'
import { fixtureCopy } from './scratch'

// A file of its own, as a process serves one project and this one serves a copy of the i18n fixture.
const path = browserPath()

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('route() in an island', () => {
  it('sets in the browser the href the server rendered, under a base and a locale with translated paths', async () => {
    const copy = await fixtureCopy('i18n')
    const base = '/shop'
    const made = 'route(\'/blog/:slug\', { slug: \'café\' }, { query: { x: 1 }, hash: \'top\' })'

    await Bun.write(join(copy, 'src/components/linker.kay'), `---\nimport { route, signal } from 'kay'\nimport { localize } from 'kay/i18n'\n\nconst shown = signal(false)\n---\ndiv\n  a.ssr(href={${made}}) Post\n  a.localized(href={localize(${made}, 'fr')}) Post\n  button(type="button" onClick={() => shown.set(true)}) Show\n  if shown()\n    a.revealed(href={${made}}) Post\n    a.revealed-localized(href={localize(${made}, 'fr')}) Post\n`)
    await Bun.write(join(copy, 'src/routes/routed.kay'), '---\nimport Linker from \'../components/linker.kay\'\n---\nLinker\n')

    const i18n = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'src/messages', paths: { '/blog/:slug': { en: '/articles/:slug' } } }
    const site = await testSite({ root: copy, i18n, base, browser: { path } })
    const front = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)

        return site.handle(new Request(new URL(`${url.pathname.slice(base.length) || '/'}${url.search}`, 'http://localhost'), { method: request.method, headers: request.headers, body: request.body, redirect: 'manual' }))
      },
    })
    const page = await browse(`${front.url.origin}${base}/en/routed`, { path })

    try {
      await page.click('button')

      const hrefOf = async (selector: string) => page.evaluate((query: string) => document.querySelector(query)?.getAttribute('href'), selector)

      expect(await hrefOf('a.ssr')).toBe('/shop/en/articles/caf%C3%A9?x=1#top')
      expect(await hrefOf('a.revealed')).toBe(await hrefOf('a.ssr'))
      expect(await hrefOf('a.localized')).toBe('/shop/blog/caf%C3%A9?x=1#top')
      expect(await hrefOf('a.revealed-localized')).toBe(await hrefOf('a.localized'))
      expect(page.errors).toEqual([])
    }
    finally {
      page.close()
      await front.stop(true)
      await site.close()
      await rm(copy, { recursive: true, force: true })
    }
  }, 60_000)
})
