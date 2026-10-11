import type { I18nConfig } from '../src/config'
import type { TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { browserPath, testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)
// What a page of an app with locales, its one small island importing nothing of kay/i18n, loads up front, gzipped, a little above what it is: the links an island sets go in the page's locale from the start, the messages and formatters wait for an island using them.
// About 1% above it, as the hashed chunk names alone move it by a dozen bytes from one clean build to the next.
const EAGER_JS_BUDGET = 15_400
const SCRIPT_URL = /<(?:script type="module" src|link rel="modulepreload" href)="([^"]+)"/g
const STATIC_IMPORT = /(?:from|import)\s*"([^"]+\.js)"/g

// Apart from tests/i18n.test.ts, as one process serves one project and this one serves a copy whose island imports nothing of kay/i18n.
describe('an island of an app with locales', () => {
  let copy: string
  let site: TestSite

  beforeAll(async () => {
    copy = await fixtureCopy('i18n')
    await Bun.write(join(copy, 'src/components/counter.kay'), '---\nimport { signal } from \'kay\'\n\nconst shown = signal(false)\n---\ndiv\n  button(type="button" onClick={() => shown.set(true)}) Show\n  if shown()\n    a.revealed(href="/about") About\n')

    const i18n: I18nConfig = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'src/messages' }

    site = await testSite({ root: copy, i18n, browser: { path: chrome } })
  }, 60_000)

  afterAll(async () => {
    await site.close()
    await rm(copy, { recursive: true, force: true })
  })

  it.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('writes the links of an island that imports nothing of kay/i18n in the page\'s locale', async () => {
    const page = await site.open('/en')

    await page.click('button')
    expect(await page.evaluate(() => document.querySelector('a.revealed')?.getAttribute('href'))).toBe('/en/about')
    expect(page.errors).toEqual([])
  }, 60_000)

  it('keeps the JS a page loads up front within its budget, kay/i18n\'s messages and formatters left to the islands using them', async () => {
    const pending = [...(await (await site.fetch('/en')).text()).matchAll(SCRIPT_URL)].map(match => match[1]!)
    const loaded = new Map<string, number>()

    for (let url = pending.pop(); url !== undefined; url = pending.pop()) {
      if (loaded.has(url))
        continue

      const code = await (await site.fetch(url)).text()

      loaded.set(url, Bun.gzipSync(code).length)
      pending.push(...[...code.matchAll(STATIC_IMPORT)].map(match => new URL(match[1]!, `http://x${url}`).pathname))
    }

    const total = loaded.values().reduce((sum, size) => sum + size, 0)

    expect(total, `${total} bytes of gzipped JS load up front, over the ${EAGER_JS_BUDGET} budget: ${[...loaded].map(([url, size]) => `${url} ${size}`).join(', ')}`).toBeLessThanOrEqual(EAGER_JS_BUDGET)
  })
})
