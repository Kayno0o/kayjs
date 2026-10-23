import type { TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { ui } from '../packages/ui/src/extension'
import { setupStore } from '../src/server/app-store'
import { memoryNotifications, notify } from '../src/server/notifications'
import { browse, browserPath, testSite } from '../src/test'
import { uiMessages, visitor, who } from './fixtures/inbox/lib/who'

// A project builds its islands once per base, so this file serves the fixture under a base and a locale prefix in a process of its own.
const ROOT = 'tests/fixtures/inbox'
const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

beforeEach(() => {
  visitor.name = 'ada'
  setupStore({ notifications: memoryNotifications() })
})

afterAll(() => {
  setupStore(undefined)
})

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('the Bell under a base and in French', () => {
  const base = '/repo'
  let site: TestSite
  let front: ReturnType<typeof Bun.serve>

  beforeAll(async () => {
    site = await testSite({ root: ROOT, extensions: [ui(), uiMessages(), who()], plugins: [tailwind], browser: { path: chrome }, base, i18n: { locales: ['en', 'fr'], defaultLocale: 'en' } })
    // The front of a real deploy takes the base off.
    front = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)

        return site.handle(new Request(new URL(`${url.pathname.slice(base.length) || '/'}${url.search}`, 'http://localhost'), { method: request.method, headers: request.headers, body: request.body, redirect: 'manual' }))
      },
    })
  }, 180_000)

  afterAll(async () => {
    await front?.stop(true)
    await site?.close()
  })

  it('links a path of the site under the base and the locale, and words the bell in the page\'s language', async () => {
    await notify('ada', { title: 'Commande expédiée', url: '/orders/12' })

    const page = await browse(`${front.url.origin}${base}/fr`, { path: chrome })

    try {
      await page.waitUntil(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label') === 'Notifications, 1 non lue')
      await page.click('.kui-bell button')
      expect(await page.evaluate(() => document.querySelector('.kui-menu-list a')?.getAttribute('href'))).toBe('/repo/orders/12')
      expect(await page.text('.kui-menu-list button.kui-menu-item')).toBe('Tout marquer comme lu')
      expect(page.errors).toEqual([])
    }
    finally {
      page.close()
    }
  }, 30_000)
})
