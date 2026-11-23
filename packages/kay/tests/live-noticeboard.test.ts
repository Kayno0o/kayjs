import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createRooms } from '../../plugin-live/src/index'
import { build } from '../src/build/index'
import { createServer } from '../src/server/index'
import { testApp } from '../src/test/index'

const NOTICEBOARD_ROOT = join(import.meta.dir, '../../../examples/noticeboard')

describe('@kayjs/live + full-stack examples/noticeboard (auth + mail + live SSE + ui + SQLite)', () => {
  it('coalesces burst presence broadcasts into a single microtask publish', async () => {
    const rooms = createRooms<{ count: number }, string>()
    const received: string[] = []
    const decoder = new TextDecoder()

    const sendPresence = rooms.coalesce(room => ({ count: rooms.size(room) }))
    const sub1 = { id: '1', member: 'a', send: (c: Uint8Array) => received.push(decoder.decode(c)), close: () => {} }
    const sub2 = { id: '2', member: 'b', send: () => {}, close: () => {} }

    rooms.join('r1', sub1)
    sendPresence('r1')
    rooms.join('r1', sub2)
    sendPresence('r1')

    await Promise.resolve()
    expect(received.length).toBe(1)
    expect(received[0]).toContain('"count":2')
  })

  it('builds and runs examples/noticeboard end-to-end across two live Chromium tabs (presence, dialog action, live toast, mail outbox, detail route & 404)', async () => {
    const manifest = await build({ root: NOTICEBOARD_ROOT, minify: true })
    expect(manifest.routes.length).toBeGreaterThanOrEqual(3)
    expect(manifest.actions.some(a => a.exportName === 'pinNotice')).toBe(true)

    // Pre-create a second member (Bob) so posting a notice delivers an announcement email to @kayjs/mail outbox
    const apiApp = await testApp({ root: NOTICEBOARD_ROOT, prebuilt: true })
    await apiApp.post('/auth/signup', { email: 'bob@noticeboard.local', password: 'bob-password-123', name: 'Bob' })

    // Verify 404 on unknown notice ID via load() returning Response
    const missing = await apiApp.get('/notices/99999')
    expect(missing.status).toBe(404)

    const app = await createServer({ root: NOTICEBOARD_ROOT })
    const server = app.serve(0)
    const origin = `http://127.0.0.1:${server.port}`

    const chromePath = [
      process.env.BUN_CHROME_PATH,
      chromium.executablePath(),
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
    ].find((p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p))

    if (chromePath === undefined) {
      server.stop(true)
      return
    }

    const browser = await chromium.launch({ headless: true, executablePath: chromePath })
    try {
      const guestCtx = await browser.newContext()
      const aliceCtx = await browser.newContext()
      const guestPage = await guestCtx.newPage()
      const alicePage = await aliceCtx.newPage()

      const errors: string[] = []
      guestPage.on('pageerror', e => errors.push(`guest: ${e.message}`))
      alicePage.on('pageerror', e => errors.push(`alice: ${e.message}`))

      // 1. Guest opens the board -> sees SSE presence "Reading now: a guest"
      await guestPage.goto(`${origin}/`, { waitUntil: 'networkidle' })
      await guestPage.waitForFunction(() => document.getElementById('presence')?.textContent?.includes('a guest'))

      // 2. Alice signs up via /login progressive form -> lands on / -> BOTH tabs update live!
      await alicePage.goto(`${origin}/login`, { waitUntil: 'networkidle' })
      await alicePage.fill('#up-name', 'Alice')
      await alicePage.fill('#up-email', 'alice@noticeboard.local')
      await alicePage.fill('#up-pass', 'alice-secret-123')
      await Promise.all([
        alicePage.waitForURL(`${origin}/`),
        alicePage.click('form[action="/auth/signup"] button[type="submit"]'),
      ])

      await guestPage.waitForFunction(() => document.getElementById('presence')?.textContent?.includes('Alice'))
      expect(await guestPage.locator('#presence').textContent()).toBe('Reading now: Alice, a guest')

      // 3. Alice opens the Dialog, pins a notice -> Guest tab immediately sees live toast AND the new notice card!
      await alicePage.click('[data-ui="dialog-root"] [data-part="trigger"]')
      await alicePage.fill('#notice-title', 'Friday Potluck')
      await alicePage.fill('#notice-body', 'Bring snacks at 18:00 in the courtyard.')
      await alicePage.click('#submit-notice')

      // Alice sees her own card + toast
      await alicePage.waitForSelector('#notice-list [data-ui="card"]')
      expect(await alicePage.locator('#notice-list [data-ui="card"] [data-part="header"]').first().textContent()).toBe('Friday Potluck')

      // Guest receives live SSE push: card appears + live toast notification!
      await guestPage.waitForSelector('#notice-list [data-ui="card"]')
      expect(await guestPage.locator('#notice-list [data-ui="card"] [data-part="header"]').first().textContent()).toBe('Friday Potluck')
      await guestPage.waitForSelector('[data-ui="toast"]')
      expect(await guestPage.locator('[data-ui="toast"] [data-part="title"]').first().textContent()).toContain('Alice pinned "Friday Potluck"')

      // 4. Guest clicks through to /notices/:id detail page
      await Promise.all([
        guestPage.waitForURL(/\/notices\/\d+$/),
        guestPage.click('#notice-list [data-ui="card"] footer a'),
      ])
      expect(await guestPage.locator('[data-ui="card"] [data-part="header"]').textContent()).toBe('Friday Potluck')

      // 5. Verify @kayjs/mail dev outbox recorded the announcement email to Bob
      const mailRes = await fetch(`${origin}/_kay/mail.json`)
      expect(mailRes.status).toBe(200)
      const mailJson = await mailRes.json() as { count: number, messages: Array<{ subject: string, to: string[] }> }
      expect(mailJson.count).toBeGreaterThanOrEqual(1)
      expect(mailJson.messages[0]!.subject).toBe('[Noticeboard] Friday Potluck')
      expect(mailJson.messages[0]!.to).toContain('bob@noticeboard.local')

      expect(errors).toEqual([])
    }
    finally {
      await browser.close()
      server.stop(true)
    }
  })
})
