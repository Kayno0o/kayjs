import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

  it('compiles examples/noticeboard with --compile and runs full-stack from an isolated temp directory', async () => {
    const buildDir = mkdtempSync(join(tmpdir(), 'kay-noticeboard-compile-build-'))
    const runCwd = mkdtempSync(join(tmpdir(), 'kay-noticeboard-compile-run-'))
    const binPath = join(buildDir, 'noticeboard-bin')
    const dbFile = join(runCwd, 'noticeboard.sqlite')
    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined

    try {
      const manifest = await build({
        root: NOTICEBOARD_ROOT,
        outDir: buildDir,
        minify: true,
        compile: binPath,
      })
      expect(existsSync(binPath)).toBe(true)
      const pinAction = manifest.actions.find(a => a.exportName === 'pinNotice')
      expect(pinAction).toBeDefined()
      expect(manifest.styles.length).toBeGreaterThan(0)
      expect(manifest.publicFiles).toContain('robots.txt')

      // Spawn the standalone executable from an empty temp directory outside the repo tree
      proc = Bun.spawn([binPath], {
        cwd: runCwd,
        env: {
          PATH: process.env.PATH ?? '',
          PORT: '0',
          NOTICEBOARD_DB: dbFile,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let stdoutBuf = ''
      let port = 0
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done)
          break
        stdoutBuf += decoder.decode(value)
        const match = /http:\/\/localhost:(\d+)/.exec(stdoutBuf)
        if (match) {
          port = Number(match[1])
          break
        }
      }
      reader.releaseLock()
      expect(port).toBeGreaterThan(0)

      const origin = `http://127.0.0.1:${port}`

      // 1. SSR HTML + security headers + custom 404
      const homeRes = await fetch(`${origin}/`)
      expect(homeRes.status).toBe(200)
      const homeHtml = await homeRes.text()
      expect(homeHtml).toContain('<title>Board — Noticeboard</title>')
      expect(homeHtml).toContain('Sign in to pin')
      expect(homeRes.headers.get('x-content-type-options')).toBe('nosniff')

      const missingRes = await fetch(`${origin}/notices/99999`)
      expect(missingRes.status).toBe(404)

      // 2. Embedded static client assets (CSS + runtime JS) & public/ file with ETag/304
      const cssRes = await fetch(`${origin}${manifest.styles[0]!}`)
      expect(cssRes.status).toBe(200)
      expect(cssRes.headers.get('content-type')).toContain('text/css')
      expect((await cssRes.text()).length).toBeGreaterThan(100)

      if (manifest.runtimeScript) {
        const rtRes = await fetch(`${origin}${manifest.runtimeScript}`)
        expect(rtRes.status).toBe(200)
        expect(rtRes.headers.get('content-type')).toContain('javascript')
      }

      const robotsRes = await fetch(`${origin}/robots.txt`)
      expect(robotsRes.status).toBe(200)
      expect(await robotsRes.text()).toContain('Allow: /')
      const etag = robotsRes.headers.get('etag')
      expect(etag).toBeTruthy()
      const robots304 = await fetch(`${origin}/robots.txt`, { headers: { 'if-none-match': etag! } })
      expect(robots304.status).toBe(304)

      // 3. Guarded action rejects unauthenticated POST with 401
      const unauthAction = await fetch(`${origin}${pinAction!.url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin': origin },
        body: JSON.stringify({ title: 'Blocked', body: 'Not signed in' }),
      })
      expect(unauthAction.status).toBe(401)

      // 4. Auth signup + signout + signin against isolated SQLite DB
      const bobSignup = await fetch(`${origin}/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin': origin },
        body: JSON.stringify({ email: 'bob@compiled.local', password: 'bob-password-123', name: 'Bob' }),
      })
      expect(bobSignup.status).toBe(201)

      const aliceSignup = await fetch(`${origin}/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin': origin },
        body: JSON.stringify({ email: 'alice@compiled.local', password: 'alice-password-123', name: 'Alice' }),
      })
      expect(aliceSignup.status).toBe(201)
      const signupCookie = aliceSignup.headers.getSetCookie()[0]!.split(';')[0]!

      const signOutRes = await fetch(`${origin}/auth/signout`, {
        method: 'POST',
        headers: { 'origin': origin, 'cookie': signupCookie },
      })
      expect(signOutRes.status).toBe(200)

      const signInRes = await fetch(`${origin}/auth/signin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin': origin },
        body: JSON.stringify({ email: 'alice@compiled.local', password: 'alice-password-123' }),
      })
      expect(signInRes.status).toBe(200)
      const sessionCookie = signInRes.headers.getSetCookie()[0]!.split(';')[0]!

      // Authenticated SSR shows signed-in user
      const authedHome = await fetch(`${origin}/`, { headers: { cookie: sessionCookie } })
      expect(authedHome.status).toBe(200)
      expect(await authedHome.text()).toContain('Alice')

      // 5. Standard-Schema validation error (400 + fieldErrors)
      const invalidAction = await fetch(`${origin}${pinAction!.url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin': origin, 'cookie': sessionCookie },
        body: JSON.stringify({ title: '   ', body: '' }),
      })
      expect(invalidAction.status).toBe(400)
      const invalidJson = await invalidAction.json() as { ok: boolean, fieldErrors: Record<string, string> }
      expect(invalidJson.ok).toBe(false)
      expect(invalidJson.fieldErrors.title).toBe('Write a title')

      // 6. Live SSE subscription + authenticated Standard-Schema action() submit -> receives live posted event!
      const sseController = new AbortController()
      const sseRes = await fetch(`${origin}/api/board`, { signal: sseController.signal })
      expect(sseRes.status).toBe(200)
      expect(sseRes.headers.get('content-type')).toContain('text/event-stream')
      const sseReader = sseRes.body!.getReader()
      const sseDecoder = new TextDecoder()

      const readUntil = async (needle: string): Promise<string> => {
        let buf = ''
        const end = Date.now() + 5_000
        while (Date.now() < end) {
          const { value, done } = await sseReader.read()
          if (done)
            break
          buf += sseDecoder.decode(value, { stream: true })
          if (buf.includes(needle))
            return buf
        }
        return buf
      }

      const initialEvent = await readUntil('"type":"present"')
      expect(initialEvent).toContain('"guests":1')

      const pinRes = await fetch(`${origin}${pinAction!.url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'origin': origin, 'cookie': sessionCookie },
        body: JSON.stringify({ title: 'Compiled Launch', body: 'Running from an isolated temp directory!' }),
      })
      expect(pinRes.status).toBe(200)
      const pinJson = await pinRes.json() as { ok: boolean, data: { id: number, title: string, author: string } }
      expect(pinJson.ok).toBe(true)
      expect(pinJson.data.title).toBe('Compiled Launch')
      expect(pinJson.data.author).toBe('Alice')

      const postedEvent = await readUntil('"type":"posted"')
      expect(postedEvent).toContain('Compiled Launch')
      sseController.abort()

      // 7. Persisted SQLite detail route renders SSR HTML
      const detailRes = await fetch(`${origin}/notices/${pinJson.data.id}`)
      expect(detailRes.status).toBe(200)
      const detailHtml = await detailRes.text()
      expect(detailHtml).toContain('Compiled Launch')
      expect(detailHtml).toContain('Running from an isolated temp directory!')
      expect(existsSync(dbFile)).toBe(true)
    }
    finally {
      if (proc !== undefined) {
        proc.kill()
        await proc.exited
      }
      rmSync(buildDir, { recursive: true, force: true })
      rmSync(runCwd, { recursive: true, force: true })
    }
  })
})
