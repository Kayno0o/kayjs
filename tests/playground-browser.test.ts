import type { TestPage } from '../src/test'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { encodeSource } from '../docs/src/playground/runnable'
import { browse, browserPath } from '../src/test'
import { takeDocsBuilt } from './docs-build'
import { freePort } from './free-port'
import { drainOutput, spawnSuiteServer, stopSuiteServer } from './listening'

const CLI = resolve('src/cli.ts')
const path = browserPath()
const COUNTER = '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count.update(n => n + 1)}) Clicked {count()} times\n'

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
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-live') === 'Clicked 0 times')

    await page.fill('.playground-input textarea', '---\n---\np Hello from the playground\n')
    await page.waitUntil(() => document.querySelector('.playground-markup code')?.textContent?.includes('Hello from the playground'))
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-live') === 'Hello from the playground')
    expect(await page.count('.playground-problems')).toBe(0)
    expect((await page.a11y('.playground')).map(violation => `${violation.id} ${violation.nodes.map(node => node.target).join(' ')}`)).toEqual([])
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

  it('revalidates the compiler bundle with its ETag instead of sending it again', async () => {
    const first = await fetch(`${origin}playground/compiler.js`)
    const etag = first.headers.get('etag') ?? ''
    const again = await fetch(`${origin}playground/compiler.js`, { headers: { 'if-none-match': etag } })

    expect(etag).toMatch(/^"[0-9a-z]+"$/)
    expect(again.status).toBe(304)
    expect((await fetch(`${origin}playground/compiler.js`)).headers.get('etag')).toBe(etag)
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
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-live')?.startsWith('probe:'))

    const outcome = await page.evaluate(() => document.querySelector('.playground-frame')?.getAttribute('data-live'))

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
    await Bun.sleep(1500)
    expect(await page.evaluate(() => document.querySelector('.playground-frame')?.getAttribute('data-live'))).toBe('')
    expect(await page.text('.playground-markup code')).toBe('')

    await page.click('.playground-result button')
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-live') === 'Clicked 0 times')
    expect(await page.count('.playground-held')).toBe(0)

    await page.fill('.playground-input textarea', '---\n---\np Typed\n')
    await page.waitUntil(() => document.querySelector('.playground-frame')?.getAttribute('data-live') === 'Typed')
  }, 60_000)

  it('leaves the other pages\' policy without eval', async () => {
    const response = await fetch(`${origin}getting-started/introduction`)

    expect(response.headers.get('content-security-policy') ?? '').not.toContain('unsafe-eval')
  })
})
