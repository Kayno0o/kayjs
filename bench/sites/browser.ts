import type { Browser } from 'playwright-core'
import type { Variant } from './sites'
import { median } from '../format'

export interface Profile {
  name: string
  viewport: { width: number, height: number }
  dpr: number
  mobile: boolean
  // Round trip in ms and throughput in bytes per second, as Chromium's network emulation takes them, and how many times slower the CPU runs.
  latency: number
  down: number
  up: number
  cpu: number
}

export interface Vitals {
  fcp: number
  lcp: number
  tbt: number
  cls: number
  load: number
  requests: number
  bytes: number
}

const KBIT = 1024 / 8
const RUNS = Number(process.env.RUNS ?? 5)

// Lighthouse's DevTools throttling: a Moto G Power on slow 4G with a 4x slower CPU, and a desktop on cable.
export const PROFILES: Profile[] = [
  { name: 'mobile', viewport: { width: 412, height: 823 }, dpr: 1.75, mobile: true, latency: 562.5, down: 1474.56 * KBIT, up: 675 * KBIT, cpu: 4 },
  { name: 'desktop', viewport: { width: 1350, height: 940 }, dpr: 1, mobile: false, latency: 40, down: 10240 * KBIT, up: 10240 * KBIT, cpu: 1 },
]

// Observers in place before the page's own scripts run.
const OBSERVE = `
window.__vitals = { lcp: 0, cls: 0, tasks: [] };
new PerformanceObserver(list => { for (const e of list.getEntries()) __vitals.lcp = e.startTime }).observe({ type: 'largest-contentful-paint', buffered: true });
new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) __vitals.cls += e.value }).observe({ type: 'layout-shift', buffered: true });
new PerformanceObserver(list => { for (const e of list.getEntries()) __vitals.tasks.push([e.startTime, e.duration]) }).observe({ type: 'longtask', buffered: true });
`

// Waits for a second without a new request, then reads the page's numbers; blocking time counts long tasks from the first paint on, as Lighthouse does up to interactive.
const COLLECT = `(async () => {
  let count = -1
  while (performance.getEntriesByType('resource').length !== count) {
    count = performance.getEntriesByType('resource').length
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  const navigation = performance.getEntriesByType('navigation')[0]
  const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0
  const resources = performance.getEntriesByType('resource')
  return {
    fcp,
    lcp: __vitals.lcp,
    tbt: __vitals.tasks.filter(([start]) => start >= fcp).reduce((sum, [, duration]) => sum + Math.max(0, duration - 50), 0),
    cls: __vitals.cls,
    load: navigation.loadEventEnd,
    requests: resources.length + 1,
    bytes: navigation.transferSize + resources.reduce((sum, r) => sum + r.transferSize, 0),
  }
})()`

// The headers the site's `auth` gave as a browser context takes them: its cookie header as the cookies of `origin`, so the page's own requests and scripts see them, the rest sent with every request.
export function browserAuth(auth: Record<string, string>, origin: string): { cookies: { name: string, value: string, url: string }[], headers: Record<string, string> } {
  const headers = Object.fromEntries(Object.entries(auth).filter(([name]) => name.toLowerCase() !== 'cookie'))
  const cookies = Object.entries(auth).filter(([name]) => name.toLowerCase() === 'cookie').flatMap(([, value]) => value.split(';')).map(pair => pair.trim()).filter(pair => pair.includes('=')).map((pair) => {
    const equals = pair.indexOf('=')

    return { name: pair.slice(0, equals), value: pair.slice(equals + 1), url: origin }
  })

  return { cookies, headers }
}

// `RUNS` cold loads of a page through nginx over HTTP/2, each in a fresh context carrying what the site's `auth` gave, medians kept. Requests to any other host, as a map frame or analytics, are aborted.
export async function vitals(browser: Browser, variant: Variant, path: string, profile: Profile, auth: Record<string, string> = {}): Promise<Vitals> {
  const runs: Vitals[] = []
  const origin = `https://localhost:${variant.ports.https}`
  const { cookies, headers } = browserAuth(auth, origin)

  for (let run = 0; run < RUNS; run++) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: profile.viewport, deviceScaleFactor: profile.dpr, isMobile: profile.mobile, hasTouch: profile.mobile, extraHTTPHeaders: headers })

    await context.addCookies(cookies)
    const page = await context.newPage()
    const session = await context.newCDPSession(page)

    await context.route(url => url.hostname !== 'localhost', async route => route.abort())
    await page.addInitScript(OBSERVE)
    await session.send('Network.enable')
    await session.send('Network.setCacheDisabled', { cacheDisabled: true })
    await session.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latency, downloadThroughput: profile.down, uploadThroughput: profile.up })
    await session.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu })
    await page.goto(`${origin}${path}`, { waitUntil: 'load' })
    runs.push(await page.evaluate<Vitals>(COLLECT))
    await context.close()
  }

  return Object.fromEntries((Object.keys(runs[0]!) as (keyof Vitals)[]).map(key => [key, median(runs.map(run => run[key]))])) as unknown as Vitals
}
