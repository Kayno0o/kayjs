import type { Vitals } from './browser'
import { chromium } from 'playwright-core'
import { median } from '../format'
import { PROFILES } from './browser'
import { startNginx, startServer, waitReady } from './serve'
import { VARIANTS } from './sites'

// One-off experiment for #88: the same build of jb-peinture on kay, its head rewritten in flight, first paint on a throttled phone.
const RUNS = Number(process.env.RUNS ?? 7)
const PAGES = ['/', '/a-propos', '/peinture']
const FONT_PRELOAD = /<link rel="preload"[^>]*as="font"[^>]*>/g
const MODULE_PRELOAD = /<link rel="modulepreload"[^>]*>/g

const REWRITES: Record<string, (html: string) => string> = {
  'as built': html => html,
  'fonts low': html => html.replace(FONT_PRELOAD, tag => tag.replace('<link ', '<link fetchpriority="low" ')),
  'modules low': html => html.replace(MODULE_PRELOAD, tag => tag.replace('<link ', '<link fetchpriority="low" ')),
  'both low': html => html.replace(FONT_PRELOAD, tag => tag.replace('<link ', '<link fetchpriority="low" ')).replace(MODULE_PRELOAD, tag => tag.replace('<link ', '<link fetchpriority="low" ')),
  'modules at body end': (html) => {
    const modules = html.match(MODULE_PRELOAD)?.join('') ?? ''

    return html.replace(MODULE_PRELOAD, '').replace('</body>', `${modules}</body>`)
  },
  'no font preload': html => html.replace(FONT_PRELOAD, ''),
  'no modulepreload': html => html.replace(MODULE_PRELOAD, ''),
  'neither': html => html.replace(FONT_PRELOAD, '').replace(MODULE_PRELOAD, ''),
  'no font preload, modules low': html => html.replace(FONT_PRELOAD, '').replace(MODULE_PRELOAD, tag => tag.replace('<link ', '<link fetchpriority="low" ')),
}
const ONLY = process.env.ONLY?.split('|')

const variant = VARIANTS.find(candidate => candidate.site.name === 'jb-peinture' && candidate.kind === 'kay')!
const profile = PROFILES.find(candidate => candidate.name === (process.env.PROFILE ?? 'mobile'))!
const nginx = await startNginx()
const server = startServer(variant)
const browser = await chromium.launch({ headless: true })

async function load(path: string, rewrite: (html: string) => string): Promise<Vitals & { hydrated: number }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: profile.viewport, deviceScaleFactor: profile.dpr, isMobile: profile.mobile, hasTouch: profile.mobile })
  const page = await context.newPage()
  const session = await context.newCDPSession(page)

  await context.route(url => url.hostname !== 'localhost', route => route.abort())
  await page.route(url => url.pathname === path, async (route) => {
    const response = await route.fetch()

    await route.fulfill({ response, body: rewrite(await response.text()) })
  })
  await page.addInitScript(`window.__cls = 0; new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) __cls += e.value }).observe({ type: 'layout-shift', buffered: true }); new PerformanceObserver(list => { for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') __fcp = e.startTime }).observe({ type: 'paint', buffered: true });`)
  await session.send('Network.enable')
  await session.send('Network.setCacheDisabled', { cacheDisabled: true })
  await session.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latency, downloadThroughput: profile.down, uploadThroughput: profile.up })
  await session.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu })
  await page.goto(`https://localhost:${variant.ports.https}${path}`, { waitUntil: 'load' })

  const result = await page.evaluate(`(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500))
    const navigation = performance.getEntriesByType('navigation')[0]
    const lcp = await new Promise(resolve => new PerformanceObserver(list => resolve(list.getEntries().at(-1).startTime)).observe({ type: 'largest-contentful-paint', buffered: true }))
    const hydrated = Math.max(0, ...performance.getEntriesByType('resource').filter(r => r.name.endsWith('.js')).map(r => r.responseEnd))
    return { cls: __cls, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0, lcp, load: navigation.loadEventEnd, hydrated }
  })()`) as Vitals & { hydrated: number }

  await context.close()

  return result
}

try {
  await waitReady(variant)

  const samples = new Map<string, { fcp: number[], lcp: number[], load: number[], hydrated: number[], cls: number[] }>(Object.keys(REWRITES).filter(name => !ONLY || ONLY.includes(name)).map(name => [name, { fcp: [], lcp: [], load: [], hydrated: [], cls: [] }]))

  for (let run = 0; run < RUNS; run++) {
    for (const path of PAGES) {
      for (const [name, rewrite] of Object.entries(REWRITES).filter(([name]) => !ONLY || ONLY.includes(name))) {
        const result = await load(path, rewrite)
        const sample = samples.get(name)!

        sample.fcp.push(result.fcp)
        sample.lcp.push(result.lcp)
        sample.load.push(result.load)
        sample.hydrated.push(result.hydrated)
        sample.cls.push(result.cls)
      }
    }

    console.error(`run ${run + 1}/${RUNS}`)
  }

  console.log(`${profile.name}, ${RUNS} runs over ${PAGES.join(' ')}, medians in ms`)
  console.log('| variant | first paint | largest paint | JS loaded | load | layout shift (max) |')
  console.log('| --- | --- | --- | --- | --- | --- |')

  for (const [name, sample] of samples)
    console.log(`| ${name} | ${median(sample.fcp).toFixed(0)} | ${median(sample.lcp).toFixed(0)} | ${median(sample.hydrated).toFixed(0)} | ${median(sample.load).toFixed(0)} | ${Math.max(...sample.cls).toFixed(3)} |`)
}
finally {
  await browser.close()
  server.kill()
  nginx.kill()
}
