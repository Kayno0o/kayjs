// First paint of a route's stylesheet copy against its inline rules, `bun run bench:paint` after `bun run docs:build`: it drives Chromium (BUN_CHROME_PATH) over throttled networks and prints a table.
// The docs' guide pages sit in the band where #988 links a copy; the inline form is made from the same page: the copy's rules in a `<style>`, the shared stylesheet linked as rest, as `pageStyles` writes it.
import type { Browser, CDPSession } from 'playwright-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { restScript } from '../src/server/client'
import { launch } from './browser'
import { kilobytes, median, milliseconds, table } from './format'

interface Profile {
  name: string
  // Bits per second and round trip in milliseconds, then how many times slower the CPU runs.
  bps: number
  rtt: number
  cpu: number
}

interface Sample {
  paint: number
  lcp: number
  load: number
  shift: number
  cpu: number
  bytes: number
}

type Form = 'copy' | 'inline'

const CLIENT = join(import.meta.dir, '..', 'docs', '.kay', 'client')
const KAY_PREFIX = '/_kay/'

// A file the page links under `/_kay/`, as the server build keeps it.
const built = (pathname: string) => join(CLIENT, 'dist', pathname.slice(KAY_PREFIX.length))
const FIRST = process.env.FIRST ?? 'guides/i18n'
const SECOND = process.env.SECOND ?? 'guides/security'
const ROUNDS = Number(process.env.ROUNDS ?? 15)
const PROFILES: Profile[] = [
  { name: 'slow 4G, CPU x4', bps: 1.6e6, rtt: 150, cpu: 4 },
  { name: '4G, CPU x4', bps: 9e6, rtt: 70, cpu: 4 },
  { name: 'cable, CPU x1', bps: 30e6, rtt: 20, cpu: 1 },
]
const COPY_LINK = /<link rel="stylesheet" href="(\/_kay\/[^"]+)(\.r-[a-z0-9]+\.css)">/
const FORMS: Form[] = ['copy', 'inline']
const OBSERVERS = `
  window.__lcp = 0
  window.__shift = 0
  new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__lcp = entry.startTime }).observe({ type: 'largest-contentful-paint', buffered: true })
  new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__shift += entry.value }).observe({ type: 'layout-shift', buffered: true })
`

const files = new Map<string, { type: string, body: Uint8Array<ArrayBuffer> }>()

// Every file is served gzipped, as a page goes out whatever the browser takes, the assets cached for good as kay serves them.
function add(path: string, type: string, body: string | Uint8Array<ArrayBuffer>): void {
  files.set(path, { type, body: new Uint8Array(Bun.gzipSync(body)) })
}

function inlineForm(html: string): string {
  const match = COPY_LINK.exec(html)

  if (match === null)
    throw new Error('the page links no stylesheet copy: build the docs first, `bun run docs:build`')

  const rules = readFileSync(built(`${match[1]}${match[2]}`), 'utf8')

  return html.replace(COPY_LINK, () => `<style>${rules}</style><link rel="stylesheet" href="${match[1]}.css" media="print" data-kay-rest>${restScript}`)
}

for (const page of [FIRST, SECOND]) {
  const html = readFileSync(join(CLIENT, 'pages', `${page}.html`), 'utf8')

  add(`/copy/${page}/`, 'text/html; charset=utf-8', html)
  add(`/inline/${page}/`, 'text/html; charset=utf-8', inlineForm(html))
}

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    let file = files.get(pathname)

    if (file === undefined && pathname.startsWith('/_kay/')) {
      const local = Bun.file(built(pathname))

      if (await local.exists())
        files.set(pathname, file = { type: local.type, body: new Uint8Array(Bun.gzipSync(new Uint8Array(await local.arrayBuffer()))) })
    }

    if (file === undefined)
      return new Response('not found', { status: 404 })

    return new Response(file.body, { headers: { 'content-type': file.type, 'content-encoding': 'gzip', 'cache-control': pathname.startsWith('/_kay/') ? 'public, max-age=31536000, immutable' : 'no-cache' } })
  },
})

async function load(session: CDPSession, page: import('playwright-core').Page, url: string): Promise<Sample> {
  let bytes = 0
  const onData = (event: { encodedDataLength: number }) => {
    bytes += event.encodedDataLength
  }

  session.on('Network.loadingFinished', onData)
  await page.goto(url, { waitUntil: 'load' })
  // A late paint or the rest stylesheet landing is waited out.
  await page.waitForFunction('performance.getEntriesByName("first-contentful-paint").length > 0')
  await page.waitForTimeout(600)
  session.off('Network.loadingFinished', onData)

  const timing = await page.evaluate(() => ({
    paint: performance.getEntriesByName('first-contentful-paint')[0]!.startTime,
    lcp: (window as unknown as { __lcp: number }).__lcp,
    shift: (window as unknown as { __shift: number }).__shift,
    load: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).loadEventStart,
  }))
  const { metrics } = await session.send('Performance.getMetrics')
  const cpu = (metrics.find(metric => metric.name === 'TaskDuration')?.value ?? 0) * 1000

  return { ...timing, cpu, bytes }
}

// One fresh context: the first page cold, then the second with the first's cache.
async function run(browser: Browser, profile: Profile, form: Form): Promise<{ cold: Sample, warm: Sample }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  const session = await context.newCDPSession(page)

  await page.addInitScript(OBSERVERS)
  await session.send('Network.enable')
  await session.send('Performance.enable')
  await session.send('Network.emulateNetworkConditions', { offline: false, latency: profile.rtt, downloadThroughput: profile.bps / 8, uploadThroughput: profile.bps / 8 })
  await session.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu })

  const origin = `http://127.0.0.1:${server.port}/${form}`
  const cold = await load(session, page, `${origin}/${FIRST}/`)
  const warm = await load(session, page, `${origin}/${SECOND}/`)

  await context.close()

  return { cold, warm }
}

const spread = (values: number[]) => `${milliseconds(median(values))} (${milliseconds(Math.min(...values))} to ${milliseconds(Math.max(...values))})`

const browser = await launch()
const rows: string[][] = []

try {
  for (const profile of PROFILES) {
    const results: Record<Form, { cold: Sample[], warm: Sample[] }> = { copy: { cold: [], warm: [] }, inline: { cold: [], warm: [] } }

    // Forms alternate within a round and swap who goes first, so a noisy stretch hits both.
    for (let round = 0; round < ROUNDS + 1; round++) {
      for (const form of round % 2 === 0 ? FORMS : FORMS.toReversed()) {
        const result = await run(browser, profile, form)

        // The first round warms the server and Chromium.
        if (round > 0) {
          results[form].cold.push(result.cold)
          results[form].warm.push(result.warm)
        }
      }
    }

    for (const cache of ['cold', 'warm'] as const) {
      for (const form of FORMS) {
        const samples = results[form][cache]

        rows.push([profile.name, cache, form, spread(samples.map(sample => sample.paint)), spread(samples.map(sample => sample.lcp)), spread(samples.map(sample => sample.load)), milliseconds(median(samples.map(sample => sample.cpu))), median(samples.map(sample => sample.shift)).toFixed(3), kilobytes(median(samples.map(sample => sample.bytes)))])
      }
    }
  }
}
finally {
  await browser.close()
  void server.stop(true)
}

console.log(`${FIRST} cold, then ${SECOND} with that cache; ${ROUNDS} runs per cell, values the median in ms (min to max), bytes over the wire\n`)
console.log(table(['network', 'cache', 'form', 'first paint', 'LCP', 'load', 'main thread', 'layout shift', 'bytes'], rows))
