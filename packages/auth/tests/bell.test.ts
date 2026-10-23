import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { ui } from '@kaynooo/kayjs-ui/extension'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { notify } from 'kay/server'
import { browserPath, testSite } from 'kay/test'
import { chromium } from 'playwright-core'
import { auth } from '../src/pages'
import { authTest } from '../src/test'

// A real test site of an app with `auth()` and the Bell: the visitor is signed in through kayjs-auth, with no stand-in for who they are.
const ROOT = join(import.meta.dir, 'bell-fixture')
const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

let site: Awaited<ReturnType<typeof testSite>>

beforeAll(async () => {
  site = await testSite({ root: ROOT, extensions: [auth(), ui()], islands: false })
}, 180_000)

afterAll(async () => {
  await site?.close()
})

describe('the Bell of kayjs-ui on kayjs-auth', () => {
  it('draws for the signed-in user and answers the inbox of notify(user.id)', async () => {
    const ada = await authTest(site).signInAs({ email: 'ada@example.com', username: 'Ada' })

    await notify(ada.id, { title: 'Order shipped', url: '/orders/12' })
    await notify(ada.id, { title: 'Invoice paid' })

    const page = await site.fetch('/')

    expect(await page.text()).toContain('kui-bell')

    const inbox = await site.fetch('/_kay/ui/inbox')

    expect(inbox.status).toBe(200)
    expect(await inbox.json()).toMatchObject({ unread: 2, items: [{ title: 'Invoice paid' }, { title: 'Order shipped', url: '/orders/12' }] })
  })

  it('draws no Bell and refuses the inbox once signed out', async () => {
    const ada = await authTest(site).signInAs({ email: 'grace@example.com', username: 'Grace' })

    await notify(ada.id, { title: 'unseen' })
    authTest(site).signOut()

    expect(await (await site.fetch('/')).text()).not.toContain('kui-bell')
    expect((await site.fetch('/_kay/ui/inbox')).status).toBe(401)
    expect((await site.fetch('/_kay/ui/inbox/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
  })

  it('gives a kayjs-auth guest no inbox', async () => {
    const page = await site.fetch('/guest')

    const html = await page.text()

    expect(page.status).toBe(200)
    expect(html).toContain('Guest')
    expect(html).not.toContain('kui-bell')
    // The guest session cookie is set, so the 401 below is the guest's and not an anonymous visitor's.
    expect(site.cookies.size).toBeGreaterThan(0)
    expect((await site.fetch('/_kay/ui/inbox')).status).toBe(401)
  })
})

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('the Bell in a browser signed in through kayjs-auth', () => {
  it('shows the unread count of notify(user.id) and none once signed out', async () => {
    const browsing = await testSite({ root: ROOT, extensions: [auth(), ui()], plugins: [tailwind], browser: { path: chrome } })

    try {
      const ada = await authTest(browsing).signInAs({ email: 'ada@example.com', username: 'Ada' })

      await notify(ada.id, { title: 'Order shipped' })
      await notify(ada.id, { title: 'Invoice paid' })

      await using page = await browsing.open('/', { cookies: await authTest(browsing).sessionCookie(ada.id) })

      await page.waitUntil(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label') === 'Notifications, 2 unread')
      expect(page.errors).toEqual([])

      // A browser opened with no cookie is the signed-out visitor.
      await using out = await browsing.open('/')

      expect(await out.count('.kui-bell')).toBe(0)
    }
    finally {
      await browsing.close()
    }
  }, 60_000)
})
