import type { Browser, CDPSession, Page } from 'playwright-core'
import type { AppName } from './apps'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

export interface LoadResult {
  html: { raw: number, gzip: number }
  js: { raw: number, gzip: number, files: number }
  domContentLoaded: number
  load: number
  script: number
  heap: number
}

export interface OperationResult {
  name: string
  median: number
  samples: number[]
}

interface Operation {
  name: string
  // Whether 1,000 rows are created before the measured click, and what must hold once it has rendered.
  withRows: boolean
  click: string
  done: string
}

const LOADS = 10
const WARMUPS = 2
const SAMPLES = 10
const ROWS = 'document.querySelectorAll("tbody tr")'

// The js-framework-benchmark's keyed operations, each checked for completion rather than assumed done.
const OPERATIONS: Operation[] = [
  { name: 'create 1,000 rows', withRows: false, click: '#run', done: `${ROWS}.length === 1000` },
  { name: 'replace 1,000 rows', withRows: true, click: '#run', done: `${ROWS}.length === 1000 && ${ROWS}[0].querySelector('.id').textContent === '1001'` },
  { name: 'update every 10th row', withRows: true, click: '#update', done: `${ROWS}[990].querySelector('a').textContent.endsWith(' !!!')` },
  { name: 'select row', withRows: true, click: 'tbody tr:nth-child(5) td.label a', done: `${ROWS}[4].className === 'danger'` },
  { name: 'swap rows', withRows: true, click: '#swaprows', done: `${ROWS}[1].querySelector('.id').textContent === '999'` },
  { name: 'remove row', withRows: true, click: 'tbody tr:nth-child(5) td.remove a', done: `${ROWS}.length === 999` },
  { name: 'create 10,000 rows', withRows: false, click: '#runlots', done: `${ROWS}.length === 10000` },
  { name: 'append 1,000 rows', withRows: true, click: '#add', done: `${ROWS}.length === 2000` },
  { name: 'clear 1,000 rows', withRows: true, click: '#clear', done: `${ROWS}.length === 0` },
]

// Starts an app's server in its own process and returns its URL.
export async function serve(app: AppName): Promise<{ url: string, stop: () => void }> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'serve.ts'), app], { stdout: 'pipe', stderr: 'inherit' })
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1

  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

async function metrics(session: CDPSession): Promise<Record<string, number>> {
  const { metrics: list } = await session.send('Performance.getMetrics')

  return Object.fromEntries(list.map(metric => [metric.name, metric.value]))
}

// Loads a page in a fresh context `LOADS` times: bytes from the network, timings and script time from Chromium, medians kept.
export async function measureLoad(browser: Browser, url: string): Promise<LoadResult> {
  const runs: LoadResult[] = []

  for (let run = 0; run < LOADS; run++) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const session = await context.newCDPSession(page)
    const scripts: Uint8Array<ArrayBuffer>[] = []
    let html = new Uint8Array()

    await session.send('Performance.enable')
    page.on('response', async (response) => {
      const type = response.request().resourceType()

      if (type === 'script')
        scripts.push(new Uint8Array(await response.body()))
      else if (type === 'document')
        html = new Uint8Array(await response.body())
    })
    await page.goto(url, { waitUntil: 'networkidle' })

    const timing = await page.evaluate(() => {
      const [navigation] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]

      return { domContentLoaded: navigation!.domContentLoadedEventEnd, load: navigation!.loadEventEnd }
    })
    const values = await metrics(session)

    runs.push({
      html: { raw: html.length, gzip: Bun.gzipSync(html).length },
      js: { raw: scripts.reduce((sum, body) => sum + body.length, 0), gzip: scripts.reduce((sum, body) => sum + Bun.gzipSync(body).length, 0), files: scripts.length },
      ...timing,
      script: (values.ScriptDuration ?? 0) * 1000,
      heap: values.JSHeapUsedSize ?? 0,
    })
    await context.close()
  }

  const last = runs.at(-1)!

  return {
    html: last.html,
    js: last.js,
    domContentLoaded: median(runs.map(run => run.domContentLoaded)),
    load: median(runs.map(run => run.load)),
    script: median(runs.map(run => run.script)),
    heap: median(runs.map(run => run.heap)),
  }
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
async function timeClick(page: Page, operation: Operation): Promise<number> {
  return page.evaluate(async ({ click, done }) => {
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

    while (!finished())
      await tick()

    void document.body.offsetHeight

    return performance.now() - start
  }, operation)
}

// Each sample runs on a freshly loaded page after its preparation clicks, as the js-framework-benchmark does.
export async function measureOperations(browser: Browser, url: string): Promise<OperationResult[]> {
  const results: OperationResult[] = []

  for (const operation of OPERATIONS) {
    const samples: number[] = []

    for (let run = 0; run < WARMUPS + SAMPLES; run++) {
      const page = await browser.newPage()

      await page.goto(`${url}/table`, { waitUntil: 'networkidle' })

      if (operation.withRows) {
        await page.click('#run')
        await page.waitForFunction(`${ROWS}.length === 1000`)
      }

      const time = await timeClick(page, operation)

      if (run >= WARMUPS)
        samples.push(time)

      await page.close()
    }

    results.push({ name: operation.name, median: median(samples), samples })
  }

  return results
}
