import type { I18nConfig } from '../src/config'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { browserPath, testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

// Apart from tests/i18n.test.ts, as one process serves one project and this one serves a copy whose island imports nothing of kay/i18n.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('an island of an app with locales', () => {
  it('writes the links of an island that imports nothing of kay/i18n in the page\'s locale', async () => {
    const copy = await fixtureCopy('i18n')
    const i18n: I18nConfig = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'src/messages' }

    await Bun.write(join(copy, 'src/components/counter.kay'), '---\nimport { signal } from \'kay\'\n\nconst shown = signal(false)\n---\ndiv\n  button(type="button" onClick={() => shown.set(true)}) Show\n  if shown()\n    a.revealed(href="/about") About\n')

    const site = await testSite({ root: copy, i18n, browser: { path: chrome } })

    try {
      const page = await site.open('/en')

      await page.click('button')
      expect(await page.evaluate(() => document.querySelector('a.revealed')?.getAttribute('href'))).toBe('/en/about')
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
      await rm(copy, { recursive: true, force: true })
    }
  }, 60_000)
})
