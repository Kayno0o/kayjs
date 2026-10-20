import type { I18nConfig } from '../src/config'
import type { TestSite } from '../src/test'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'
import { expectEagerJsWithin } from './eager-js'
import { fixtureCopy } from './scratch'

const chrome = browserPath()
// What a page of an app with locales, its one small island importing nothing of kay/i18n, loads up front, gzipped, as measured, with `EAGER_JS_SLACK` of margin on top: the links an island sets go in the page's locale from the start, the messages and formatters wait for an island using them.
// The check for a visitor asking to save data, which islands with no `hydrate` wait on, costs about 105 to 140 bytes here, read before the first island hydrates so it cannot wait in a chunk.
// This unminified build keeps the three dead `if (false)` of the French spacing, 16 bytes the minified build of a site not in French does not carry.
const EAGER_JS_BUDGET = 15_401

// Apart from tests/i18n.test.ts, as one process serves one project and this one serves a copy whose island imports nothing of kay/i18n.
describe('an island of an app with locales', () => {
  let copy: string
  let site: TestSite

  beforeAll(async () => {
    copy = await fixtureCopy('i18n', true)
    await Bun.write(join(copy, 'src/components/counter.kay'), '---\nimport { signal } from \'kay\'\n\nconst shown = signal(false)\n---\ndiv\n  button(type="button" onClick={() => shown.set(true)}) Show\n  if shown()\n    a.revealed(href="/about") About\n')

    const i18n: I18nConfig = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'src/messages' }

    // The French spacing of an island's text has its own budget, in tests/typography-islands.test.ts.
    site = await testSite({ root: copy, i18n, typography: false, browser: { path: chrome } })
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
    await expectEagerJsWithin(EAGER_JS_BUDGET, await (await site.fetch('/en')).text(), async url => (await site.fetch(url)).text())
  })
})
