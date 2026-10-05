import type { Browser, CDPSession, Page } from 'playwright-core'
import type { AppName } from './apps'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { median } from './format'
import { visibleRows } from './markup'

export interface LoadResult {
  html: { raw: number, gzip: number }
  js: { raw: number, gzip: number, files: number }
  // Main-thread milliseconds Chromium spent up to network idle: hydration lands in `script`, the page's first render in `style` and `layout`.
  script: number
  style: number
  layout: number
  heap: number
}

export interface OperationResult {
  name: string
  median: number
  samples: number[]
}

export interface Operation {
  name: string
  // Whether 1,000 rows are created before the measured click, and what must hold once it has rendered.
  withRows: boolean
  click: string
  done: string
}

const LOADS = 10

export const WARMUPS = 2
const SAMPLES = 10
const OPERATION_TIMEOUT_MS = 10_000
// More than any framework chains before its update lands.
const MICROTASK_CHECKS = 100
// A live collection, so each completion check costs the same however the framework updates the table.
const ROWS = 'document.querySelector("tbody").rows'

// The js-framework-benchmark's keyed operations, each checked for completion rather than assumed done.
export const OPERATIONS: Operation[] = [
  { name: 'create 1,000 rows', withRows: false, click: '#run', done: `${ROWS}.length === 1000` },
  { name: 'replace 1,000 rows', withRows: true, click: '#run', done: `${ROWS}.length === 1000 && ${ROWS}[0].cells[0].textContent === '1001'` },
  { name: 'update every 10th row', withRows: true, click: '#update', done: `${ROWS}[990].cells[1].textContent.endsWith(' !!!')` },
  { name: 'select row', withRows: true, click: 'tbody tr:nth-child(5) td.label a', done: `${ROWS}[4].className === 'danger'` },
  { name: 'swap rows', withRows: true, click: '#swaprows', done: `${ROWS}[1].cells[0].textContent === '999'` },
  { name: 'remove row', withRows: true, click: 'tbody tr:nth-child(5) td.remove a', done: `${ROWS}.length === 999` },
  { name: 'create 10,000 rows', withRows: false, click: '#runlots', done: `${ROWS}.length === 10000` },
  { name: 'append 1,000 rows', withRows: true, click: '#add', done: `${ROWS}.length === 2000` },
  { name: 'clear 1,000 rows', withRows: true, click: '#clear', done: `${ROWS}.length === 0` },
]

// Starts an app's server in its own process and returns its URL; `env` adds to the environment it gets.
export async function serve(app: AppName, env: Record<string, string> = {}): Promise<{ url: string, stop: () => void }> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'serve.ts'), app], { stdout: 'pipe', stderr: 'inherit', env: { ...process.env, NODE_ENV: 'production', ...env } })
  const reader = child.stdout.getReader()
  let output = ''

  while (!output.includes('\n')) {
    const { value, done } = await reader.read()

    if (done)
      throw new Error(`${app} server exited before it was ready`)

    output += new TextDecoder().decode(value)
  }

  reader.releaseLock()

  return { url: `http://localhost:${output.trim().slice('ready '.length)}`, stop: () => child.kill() }
}

export async function launch(): Promise<Browser> {
  return chromium.launch({ headless: true })
}

async function responseBody(type: string, body: Promise<Buffer>): Promise<{ type: string, body: Uint8Array<ArrayBuffer> }> {
  return { type, body: new Uint8Array(await body) }
}

async function metrics(session: CDPSession): Promise<Record<string, number>> {
  const { metrics: list } = await session.send('Performance.getMetrics')

  return Object.fromEntries(list.map(metric => [metric.name, metric.value]))
}

// Loads a page in a fresh context `LOADS` times: bytes from the network, main-thread costs from Chromium, medians kept.
// DOMContentLoaded is left out: across identical loads it swings between about 25 and 70 ms with when Chromium paints the page, not with the framework.
export async function measureLoad(browser: Browser, url: string): Promise<LoadResult> {
  const runs: LoadResult[] = []

  for (let run = 0; run < LOADS; run++) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const session = await context.newCDPSession(page)
    const bodies: Promise<{ type: string, body: Uint8Array<ArrayBuffer> }>[] = []

    await session.send('Performance.enable')
    page.on('response', (response) => {
      bodies.push(responseBody(response.request().resourceType(), response.body()))
    })
    await page.goto(url, { waitUntil: 'networkidle' })

    const responses = await Promise.all(bodies)
    const html = responses.find(response => response.type === 'document')?.body
    const scripts = responses.filter(response => response.type === 'script').map(response => response.body)
    const values = await metrics(session)

    if (!html || html.length === 0)
      throw new Error(`No document captured for ${url}`)

    runs.push({
      html: { raw: html.length, gzip: Bun.gzipSync(html).length },
      js: { raw: scripts.reduce((sum, body) => sum + body.length, 0), gzip: scripts.reduce((sum, body) => sum + Bun.gzipSync(body).length, 0), files: scripts.length },
      script: (values.ScriptDuration ?? 0) * 1000,
      style: (values.RecalcStyleDuration ?? 0) * 1000,
      layout: (values.LayoutDuration ?? 0) * 1000,
      heap: values.JSHeapUsedSize ?? 0,
    })
    await context.close()
  }

  const last = runs.at(-1)!

  return {
    html: last.html,
    js: last.js,
    script: median(runs.map(run => run.script)),
    style: median(runs.map(run => run.style)),
    layout: median(runs.map(run => run.layout)),
    heap: median(runs.map(run => run.heap)),
  }
}

// The rows the table renders on the client, which server-rendered markup never shows: hydration markers and keys stripped.
export async function tableRows(browser: Browser, url: string): Promise<string> {
  const page = await browser.newPage()

  await page.goto(`${url}/table`, { waitUntil: 'networkidle' })
  await page.click('#run')
  await page.waitForFunction(`${ROWS}.length === 1000`, undefined, { timeout: OPERATION_TIMEOUT_MS })

  const rows = await page.evaluate(() => document.querySelector('tbody')!.innerHTML)

  await page.close()

  return visibleRows(rows)
}

// Checks the counter answers a click, so the timings above belong to a hydrated page.
export async function assertHydrated(browser: Browser, url: string): Promise<void> {
  const page = await browser.newPage()

  await page.goto(url, { waitUntil: 'networkidle' })
  await page.click('.counter')
  await page.waitForFunction(() => document.querySelector('.counter')?.textContent?.includes('Clicked 1'), undefined, { timeout: 5000 })
  await page.close()
}

// Times one click until its result is in the DOM and laid out: scripting, style and layout, not paint.
// The result is checked after each microtask first: Chromium may render a frame before the next task, and whether it does depends on where the click falls in the frame, not on the framework.
export async function timeClick(page: Page, operation: Operation): Promise<number> {
  return page.evaluate(async ({ click, done, timeout, microtasks }) => {
    // eslint-disable-next-line no-new-func -- the completion check is data, written as an expression over the document
    const finished = new Function(`return ${done}`) as () => boolean
    const tick = async () => new Promise<void>((resolve) => {
      const channel = new MessageChannel()

      channel.port1.onmessage = () => resolve()
      channel.port2.postMessage(0)
    })
    const target = document.querySelector<HTMLElement>(click)!
    const start = performance.now()

    target.click()

    for (let check = 0; check < microtasks && !finished(); check++)
      await Promise.resolve()

    while (!finished()) {
      await tick()

      if (performance.now() - start > timeout)
        throw new Error(`${click} never reached ${done}`)
    }

    void document.body.offsetHeight

    return performance.now() - start
  }, { ...operation, timeout: OPERATION_TIMEOUT_MS, microtasks: MICROTASK_CHECKS })
}

// A fresh table page, holding 1,000 rows when the operation starts from them.
export async function openTable(browser: Browser, url: string, operation: Operation): Promise<Page> {
  const page = await browser.newPage()

  await page.goto(`${url}/table`, { waitUntil: 'networkidle' })

  if (operation.withRows) {
    await page.click('#run')
    await page.waitForFunction(`${ROWS}.length === 1000`, undefined, { timeout: OPERATION_TIMEOUT_MS })
  }

  return page
}

// Each sample runs on a freshly loaded page after its preparation clicks, as the js-framework-benchmark does.
export async function measureOperations(browser: Browser, url: string): Promise<OperationResult[]> {
  const results: OperationResult[] = []

  for (const operation of OPERATIONS) {
    const samples: number[] = []

    for (let run = 0; run < WARMUPS + SAMPLES; run++) {
      const page = await openTable(browser, url, operation)
      const time = await timeClick(page, operation)

      if (run >= WARMUPS)
        samples.push(time)

      await page.close()
    }

    results.push({ name: operation.name, median: median(samples), samples })
  }

  return results
}
