// Milestone 1 Benchmark Suite for Kay v2:
// Measures clean build time, bundle sizes, in-process SSR throughput, Chromium load metrics, and 9 js-framework-benchmark ops.

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { measure } from 'mitata'
import { chromium } from 'playwright-core'
import { build } from 'kay/build'
import { createServer } from 'kay/server'

const ROOT = import.meta.dir

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

// 1. Clean Build benchmark (median of 3 runs)
const buildTimes: number[] = []
let manifest!: Awaited<ReturnType<typeof build>>
for (let i = 0; i < 3; i++) {
  rmSync(join(ROOT, 'dist'), { recursive: true, force: true })
  const t0 = performance.now()
  manifest = await build({ root: ROOT, minify: true })
  buildTimes.push(performance.now() - t0)
}

const clientDir = join(ROOT, 'dist/client')
const clientFiles = readdirSync(clientDir).filter(f => f.endsWith('.js'))
let totalClientRaw = 0
let totalClientGzip = 0
const perFileSizes: { file: string, raw: number, gzip: number }[] = []
for (const f of clientFiles) {
  const buf = readFileSync(join(clientDir, f))
  const gz = Bun.gzipSync(buf).length
  totalClientRaw += buf.length
  totalClientGzip += gz
  perFileSizes.push({ file: f, raw: buf.length, gzip: gz })
}

console.log('\n=== 1. BUILD ===')
console.log(`Clean build (median of 3): ${median(buildTimes).toFixed(1)} ms`)
console.log(`Client output: ${(totalClientRaw / 1024).toFixed(2)} KB raw / ${(totalClientGzip / 1024).toFixed(2)} KB gzip (${clientFiles.length} JS files)`)
for (const f of perFileSizes)
  console.log(`  - ${f.file}: ${f.raw} B raw (${f.gzip} B gzip)`)

// 2. SSR Throughput (in-process via mitata, identical to bench/ssr.ts)
const app = await createServer({ root: ROOT })
const renderProducts = async () => (await app.handle(new Request('http://localhost/'))).text()
await renderProducts()
const ssrStats = await measure(renderProducts, { min_cpu_time: 2e9 })
const rendersPerSec = Math.round(1e9 / ssrStats.avg)

console.log('\n=== 2. SERVER RENDERING (500 products + Counter) ===')
console.log(`renders/s: ${rendersPerSec}`)
console.log(`mean: ${(ssrStats.avg / 1e6).toFixed(3)} ms | p50: ${(ssrStats.p50 / 1e6).toFixed(3)} ms | p99: ${(ssrStats.p99 / 1e6).toFixed(3)} ms`)

// 3. Chromium Loads & 9 Keyed Table Operations
const chromePath = process.env.BUN_CHROME_PATH || chromium.executablePath()
if (!existsSync(chromePath)) {
  console.log(`\nSkipping Chromium benchmarks: no executable at ${chromePath}`)
  process.exit(0)
}

const server = app.serve(0)
const baseUrl = `http://localhost:${server.port}`
const browser = await chromium.launch({ headless: true, executablePath: chromePath })

async function measureLoad(url: string) {
  const scripts: number[] = []
  const styles: number[] = []
  const layouts: number[] = []
  const heaps: number[] = []
  let htmlRaw = 0
  let htmlGzip = 0
  let jsRaw = 0
  let jsGzip = 0
  let jsFiles = 0

  for (let i = 0; i < 5; i++) {
    const context = await browser.newContext()
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    const bodies: Promise<{ type: string, body: Uint8Array<ArrayBuffer> }>[] = []

    await cdp.send('Performance.enable')
    page.on('response', (res) => {
      bodies.push(res.body().then(b => ({ type: res.request().resourceType(), body: new Uint8Array(b) })))
    })

    await page.goto(url, { waitUntil: 'networkidle' })
    const loaded = await Promise.all(bodies)
    const { metrics } = await cdp.send('Performance.getMetrics')
    const m = Object.fromEntries(metrics.map(x => [x.name, x.value]))

    const doc = loaded.find(x => x.type === 'document')!.body
    const js = loaded.filter(x => x.type === 'script').map(x => x.body)
    htmlRaw = doc.length
    htmlGzip = Bun.gzipSync(doc).length
    jsRaw = js.reduce((s, b) => s + b.length, 0)
    jsGzip = js.reduce((s, b) => s + Bun.gzipSync(b).length, 0)
    jsFiles = js.length

    scripts.push((m.ScriptDuration ?? 0) * 1000)
    styles.push((m.RecalcStyleDuration ?? 0) * 1000)
    layouts.push((m.LayoutDuration ?? 0) * 1000)
    heaps.push(m.JSHeapUsedSize ?? 0)
    await context.close()
  }

  return {
    htmlRaw, htmlGzip, jsRaw, jsGzip, jsFiles,
    script: median(scripts),
    style: median(styles),
    layout: median(layouts),
    heap: median(heaps),
  }
}

try {
  const prod = await measureLoad(`${baseUrl}/`)
  console.log('\n=== 3. PRODUCTS PAGE IN CHROMIUM ===')
  console.log(`JS shipped: ${(prod.jsGzip / 1024).toFixed(2)} KB gzip (${(prod.jsRaw / 1024).toFixed(2)} KB raw, ${prod.jsFiles} files)`)
  console.log(`HTML: ${(prod.htmlGzip / 1024).toFixed(2)} KB gzip (${(prod.htmlRaw / 1024).toFixed(2)} KB raw)`)
  console.log(`script: ${prod.script.toFixed(2)} ms | style: ${prod.style.toFixed(2)} ms | layout: ${prod.layout.toFixed(2)} ms | heap: ${(prod.heap / 1024).toFixed(1)} KB`)

  const tbl = await measureLoad(`${baseUrl}/table`)
  console.log('\n=== 4. TABLE PAGE IN CHROMIUM ===')
  console.log(`JS shipped: ${(tbl.jsGzip / 1024).toFixed(2)} KB gzip (${(tbl.jsRaw / 1024).toFixed(2)} KB raw, ${tbl.jsFiles} files)`)
  console.log(`HTML: ${(tbl.htmlGzip / 1024).toFixed(2)} KB gzip (${(tbl.htmlRaw / 1024).toFixed(2)} KB raw)`)
  console.log(`script: ${tbl.script.toFixed(2)} ms | style: ${tbl.style.toFixed(2)} ms | layout: ${tbl.layout.toFixed(2)} ms | heap: ${(tbl.heap / 1024).toFixed(1)} KB`)

  // Verify counter actually works in real Chromium!
  const verifyPage = await browser.newPage()
  await verifyPage.goto(`${baseUrl}/`, { waitUntil: 'networkidle' })
  await verifyPage.click('button.counter')
  const counterText = await verifyPage.textContent('button.counter')
  if (counterText !== 'Clicked 1')
    throw new Error(`Counter hydration check failed: got ${JSON.stringify(counterText)}`)
  await verifyPage.close()

  // Measure all 9 keyed table operations (same checks as bench/browser.ts)
  const ROWS = 'document.querySelector("tbody").rows'
  const OPS = [
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

  console.log('\n=== 5. TABLE OPERATIONS IN CHROMIUM (median ms) ===')
  for (const op of OPS) {
    const samples: number[] = []
    for (let i = 0; i < 7; i++) {
      const context = await browser.newContext()
      const page = await context.newPage()
      await page.goto(`${baseUrl}/table`, { waitUntil: 'networkidle' })
      if (op.withRows) {
        await page.click('#run')
        await page.waitForFunction(() => document.querySelector('tbody')!.rows.length === 1000)
      }

      const ms = await page.evaluate(async ({ click, done }) => {
        const target = document.querySelector<HTMLElement>(click)!
        const check = new Function(`return ${done}`) as () => boolean
        const t0 = performance.now()
        target.click()
        while (!check())
          await Promise.resolve()
        void document.body.offsetHeight
        return performance.now() - t0
      }, { click: op.click, done: op.done })

      if (i >= 2)
        samples.push(ms)
      await context.close()
    }
    console.log(`  ${op.name.padEnd(24)} ${median(samples).toFixed(2)} ms`)
  }
}
finally {
  await browser.close()
  server.stop(true)
}
