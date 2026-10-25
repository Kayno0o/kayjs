import type { TestPage } from '../src/test'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { encodeSource } from '../docs/src/playground/runnable'
import { SAMPLE } from '../docs/src/playground/sample'
import { browse, browserPath } from '../src/test'
import { takeDocsBuilt } from './docs-build'
import { freePort } from './free-port'
import { drainOutput, spawnSuiteServer, stopSuiteServer } from './listening'

const CLI = resolve('src/cli.ts')
const path = browserPath()
const COUNTER = '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count++}) Clicked {count()} times\n'

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok
  }
  catch {
    return false
  }
}

// Tries the docs page's document, storage, cookies, address and a forged reply from inside the frame, and shows how many were refused.
const PROBE = `---
const attempts: Array<() => unknown> = [
  () => window.parent.document.title,
  () => window.parent.localStorage.getItem('secret'),
  () => document.cookie,
  () => localStorage.getItem('secret'),
  () => { window.parent.location.hash = '#hijacked' },
  () => { window.parent.history.replaceState(null, '', '#hijacked') },
]
const results = attempts.map((attempt) => {
  try {
    attempt()
    return 'allowed'
  }
  catch {
    return 'blocked'
  }
})
window.parent.postMessage({ id: 999999, html: 'FORGED' }, '*')
---
p probe:{results.join(',')}
`

// Answers at once, then blocks the frame from a timer, which a watchdog that stops at the first reply misses.
const LATE = `---
import { onMount } from 'kay'

onMount(() => {
  setInterval(() => {
    while (true) {}
  }, 500)
})
---
p fine
`

let server: Bun.Subprocess
let origin: string
let page: TestPage
let release: (() => Promise<void>) | undefined

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the docs playground in a browser', () => {
  beforeAll(async () => {
    release = await takeDocsBuilt()

    const port = freePort()

    server = spawnSuiteServer([process.execPath, CLI, 'start', 'docs', '--port', String(port)])
    drainOutput(server)
    origin = `http://localhost:${port}/`

    for (let tries = 0; tries < 100 && !await reachable(origin); tries++)
      await Bun.sleep(100)

    if (!await reachable(origin))
      throw new Error('kay start did not serve the docs')

    page = await browse(origin, { path, width: 1440, height: 900 })
  }, 300_000)

  afterAll(async () => {
    page?.close()
    await stopSuiteServer(server)
    await release?.()
  })

  it('opens an example from the address, shows the server\'s markup and the live component, and follows an edit', async () => {
    await page.goto(`/getting-started/playground#code=${encodeSource(COUNTER)}`)
    await page.click('.playground-result button')
    await page.waitUntil(() => document.querySelector('.playground-markup code')?.textContent?.includes('Clicked 0 times'))
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live') === 'Clicked 0 times')

    await page.fill('.playground-input textarea', '---\n---\np Hello from the playground\n')
    await page.waitUntil(() => document.querySelector('.playground-markup code')?.textContent?.includes('Hello from the playground'))
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live') === 'Hello from the playground')
    expect(await page.count('.playground-problems')).toBe(0)
    expect((await page.a11y('.playground')).map(violation => `${violation.id} ${violation.nodes.map(node => node.target).join(' ')}`)).toEqual([])
    expect(page.errors).toEqual([])
  }, 60_000)

  it('runs the sample on its own: a click in the frame counts, and the frame logs no error', async () => {
    await page.goto('/getting-started/playground')
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live') === 'Clicked 0 times', { timeout: '15s' })
    expect(await page.evaluate(() => (document.querySelector('.playground-input textarea') as HTMLTextAreaElement).value)).toBe(SAMPLE)

    // The button is the first thing in the frame, under its 1rem padding, and a sandboxed frame is out of the page's reach: the click is the browser's own, at the button's place.
    for (const count of [1, 2]) {
      const { x, y } = await page.evaluate(() => {
        const { left, top } = document.querySelector('.playground-frame')!.getBoundingClientRect()

        return { x: left + 30, y: top + 30 }
      })

      for (const type of ['mousePressed', 'mouseReleased'])
        await page.cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })

      await page.waitUntil((expected: string) => document.querySelector('.playground-frame')?.getAttribute('data-test-live') === expected, { timeout: '15s' }, `Clicked ${count} times`)
    }

    expect(page.errors).toEqual([])
  }, 60_000)

  it('shows a compile error at its line and keeps the last good result', async () => {
    await page.fill('.playground-input textarea', '---\n---\ndiv\n  p {1 +}\n')
    await page.waitFor('.playground-problems')
    expect(await page.text('.playground-problems')).toMatch(/playground\.kay:4/)
    expect(await page.text('.playground-markup code')).toContain('Hello from the playground')
  }, 60_000)

  it('serves the frame with a policy of its own, and sandboxes it without the docs\' origin', async () => {
    const response = await fetch(`${origin}playground/frame.html`)
    const policy = response.headers.get('content-security-policy') ?? ''

    expect(policy).toContain('default-src \'none\'')
    expect(policy).toContain('\'unsafe-eval\'')
    expect((await (await fetch(origin)).text())).not.toContain('unsafe-eval')
    expect(await page.evaluate(() => document.querySelector('.playground-frame')?.getAttribute('sandbox'))).toBe('allow-scripts')
  })

  it('revalidates the compiler bundle with an ETag per encoding, as RFC 9110 reads If-None-Match', async () => {
    const url = `${origin}playground/compiler.js`
    const brotli = await fetch(url, { headers: { 'accept-encoding': 'br' } })
    const plain = await fetch(url, { headers: { 'accept-encoding': 'identity' } })
    const brotliTag = brotli.headers.get('etag') ?? ''
    const plainTag = plain.headers.get('etag') ?? ''
    const asked = async (tag: string, encoding: string) => fetch(url, { headers: { 'accept-encoding': encoding, 'if-none-match': tag } })

    expect(brotliTag).toMatch(/^"[0-9a-z]+-br"$/)
    expect(plainTag).toMatch(/^"[0-9a-z]+"$/)
    expect(brotli.headers.get('content-encoding')).toBe('br')
    expect(plain.headers.get('content-encoding')).toBeNull()

    const again = await asked(brotliTag, 'br')

    expect(again.status).toBe(304)
    expect(again.headers.get('vary')).toBe('accept-encoding')
    expect((await asked(plainTag, 'identity')).status).toBe(304)
    expect((await asked(plainTag, 'br')).status).toBe(200)
    expect((await asked(brotliTag, 'identity')).status).toBe(200)
    expect((await asked(`"other", W/${brotliTag}`, 'br')).status).toBe(304)
    expect((await asked('*', 'br')).status).toBe(304)
    expect((await asked('"other"', 'br')).status).toBe(200)
  })

  it('keeps code in the frame from reaching the docs page: its document, storage, cookies and state', async () => {
    await page.goto('/getting-started/introduction')
    await page.evaluate(() => {
      localStorage.setItem('secret', 'parent')
      document.cookie = 'session=parent; path=/'
    })
    await page.goto('/getting-started/playground')
    await page.waitFor('.playground-frame')
    await page.fill('.playground-input textarea', PROBE)
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live')?.startsWith('probe:'))

    const outcome = await page.evaluate(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live'))

    expect(outcome).toBe('probe:blocked,blocked,blocked,blocked,blocked,blocked')
    expect(await page.evaluate(() => localStorage.getItem('secret'))).toBe('parent')
    expect(await page.text('.playground-markup code')).not.toContain('FORGED')
    expect(page.errors).toEqual([])
  }, 60_000)

  it('holds code that came from a link until Run is clicked, and runs typed code at once', async () => {
    await page.goto('/getting-started/introduction')
    await page.goto(`/getting-started/playground#code=${encodeSource(COUNTER)}`)
    await page.waitFor('.playground-held')
    await page.waitUntil(() => document.querySelector('.playground-input textarea') instanceof HTMLTextAreaElement && (document.querySelector('.playground-input textarea') as HTMLTextAreaElement).value.includes('Clicked'))
    await page.waitFor('.playground-result[aria-busy="false"]')
    expect(await page.evaluate(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live'))).toBe('')
    expect(await page.text('.playground-markup code')).toBe('')

    await page.click('.playground-result button')
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live') === 'Clicked 0 times')
    expect(await page.count('.playground-held')).toBe(0)

    await page.fill('.playground-input textarea', '---\n---\np Typed\n')
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live') === 'Typed')
  }, 60_000)

  it('reads a link pasted onto the page, holding its code until Run', async () => {
    await page.goto('/getting-started/playground')
    await page.waitFor('.playground-result[aria-busy="false"]')
    await page.fill('.playground-input textarea', '---\n---\np Typed\n')
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live') === 'Typed')

    await page.evaluate((hash: string) => {
      location.hash = hash
    }, `#code=${encodeSource('---\n---\np Pasted\n')}`)
    await page.waitFor('.playground-held')
    await page.waitUntil(() => (document.querySelector('.playground-input textarea') as HTMLTextAreaElement).value.includes('Pasted'))
    await page.click('.playground-result button')
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live') === 'Pasted')
  }, 60_000)

  it('resets a box whose code never finishes, and runs the next code in a new frame', async () => {
    await page.goto('/getting-started/introduction')
    await page.goto('/getting-started/playground')
    await page.waitFor('.playground-result[aria-busy="false"]')
    await page.evaluate(() => {
      (window as unknown as { hung: Element | null }).hung = document.querySelector('.playground-frame')
    })
    await page.fill('.playground-input textarea', '---\nwhile (true) {}\n---\np loop\n')
    await page.waitFor('.playground-error', { timeout: '15s' })
    expect(await page.text('.playground-error')).toContain('stopped responding')
    expect(await page.text('.playground-markup code')).toBe('')
    await page.waitFor('.playground-result[aria-busy="false"]', { timeout: '15s' })
    expect(await page.evaluate(() => document.querySelectorAll('.playground-frame').length)).toBe(1)
    expect(await page.evaluate(() => document.querySelector('.playground-frame') !== (window as unknown as { hung: Element | null }).hung)).toBe(true)

    await page.fill('.playground-input textarea', '---\n---\np Recovered\n')
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live') === 'Recovered', { timeout: '15s' })
    expect(await page.count('.playground-error')).toBe(0)
  }, 60_000)

  it('keeps a frame that answers while the page itself is busy past the limit', async () => {
    await page.goto('/getting-started/playground')
    await page.waitFor('.playground-result[aria-busy="false"]')
    await page.fill('.playground-input textarea', '---\n---\np Steady\n')
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live') === 'Steady', { timeout: '15s' })
    await page.evaluate(() => {
      const end = Date.now() + 3600

      while (Date.now() < end) {
        // The page's main thread is busy while the frame is not.
      }
    })
    await Bun.sleep(2500)
    expect(await page.count('.playground-error')).toBe(0)
    await page.fill('.playground-input textarea', '---\n---\np Still here\n')
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live') === 'Still here', { timeout: '15s' })
  }, 60_000)

  it('resets a box whose code answers first and blocks later', async () => {
    await page.fill('.playground-input textarea', LATE)
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live') === 'fine', { timeout: '15s' })
    await page.waitFor('.playground-error', { timeout: '15s' })
    expect(await page.text('.playground-error')).toContain('stopped responding')
    await page.waitFor('.playground-result[aria-busy="false"]', { timeout: '15s' })

    await page.fill('.playground-input textarea', '---\n---\np Back\n')
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-test-live') === 'Back', { timeout: '15s' })
  }, 60_000)

  it('leaves the other pages\' policy without eval', async () => {
    const response = await fetch(`${origin}getting-started/introduction`)

    expect(response.headers.get('content-security-policy') ?? '').not.toContain('unsafe-eval')
  })
})
