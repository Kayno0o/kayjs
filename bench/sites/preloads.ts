import type { Browser } from 'playwright-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { median } from '../format'
import { PROFILES } from './browser'
import { startNginx, startServer, waitReady } from './serve'
import { VARIANTS } from './sites'

// The experiment behind #88: jb-peinture's kay build as `bench:sites` last built it, its head's preloads rewritten in flight, timed under Lighthouse's throttling.
// The rewritten document is served by Playwright, so it skips the throttled network every other request takes: compare variants with each other, never with `bench:sites`.
// Variants run interleaved, page after page and run after run, medians pooled over the pages; `RUNS`, `PROFILE=desktop` and `ONLY=as built|neither` narrow it.
const RUNS = Number(process.env.RUNS ?? 7)
const PAGES = ['/', '/a-propos', '/peinture']
const FONT_PRELOAD = /<link rel="preload"[^>]*as="font"[^>]*>/g
const MODULE_PRELOAD = /<link rel="modulepreload"[^>]*>/g
const FONTS_STYLESHEET = /<link rel="stylesheet" href="\/_kay\/assets\/(fonts-[^"]+\.css)">/
const PAGE_STYLESHEET = /<link rel="stylesheet" href="\/_kay\/(?!assets\/)[^"]+">/g
const VIEWPORT = /<meta name="viewport"[^>]*>/

const variant = VARIANTS.find(candidate => candidate.site.name === 'jb-peinture' && candidate.kind === 'kay')!

const low = (tag: string): string => tag.replace('<link ', '<link fetchpriority="low" ')

// The `@font-face` rules in a `<style>` of the head rather than a stylesheet of their own.
function fontsInline(html: string): string {
  return html.replace(FONTS_STYLESHEET, (_, name: string) => `<style>${readFileSync(join(variant.dir, '.kay/client/dist/assets', name), 'utf8')}</style>`)
}

// The page's stylesheets right after the viewport, ahead of the metas, structured data and title.
function cssFirst(html: string): string {
  const sheets = html.match(PAGE_STYLESHEET)?.join('') ?? ''

  return html.replace(PAGE_STYLESHEET, '').replace(VIEWPORT, tag => tag + sheets)
}

const REWRITES: Record<string, (html: string) => string> = {
  'as built': html => html,
  'fonts low': html => html.replace(FONT_PRELOAD, low),
  'modules low': html => html.replace(MODULE_PRELOAD, low),
  'both low': html => html.replace(FONT_PRELOAD, low).replace(MODULE_PRELOAD, low),
  'modules at body end': (html) => {
    const modules = html.match(MODULE_PRELOAD)?.join('') ?? ''

    return html.replace(MODULE_PRELOAD, '').replace('</body>', `${modules}</body>`)
  },
  'no font preload': html => html.replace(FONT_PRELOAD, ''),
  'no modulepreload': html => html.replace(MODULE_PRELOAD, ''),
  'neither': html => html.replace(FONT_PRELOAD, '').replace(MODULE_PRELOAD, ''),
  'no font preload, modules low': html => html.replace(FONT_PRELOAD, '').replace(MODULE_PRELOAD, low),
  'fonts inline': fontsInline,
  'css first': cssFirst,
  'css first, fonts inline': html => cssFirst(fontsInline(html)),
}

// Waits until no request has started for a second, then reads the paints, the layout shift and when the last script arrived.
const COLLECT = `(async () => {
  let count = -1
  while (performance.getEntriesByType('resource').length !== count) {
    count = performance.getEntriesByType('resource').length
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  const navigation = performance.getEntriesByType('navigation')[0]
  const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0
  const scripts = Math.max(0, ...performance.getEntriesByType('resource').filter(r => r.name.endsWith('.js')).map(r => r.responseEnd))
  return { fcp, lcp: __lcp, cls: __cls, scripts, load: navigation.loadEventEnd }
})()`
const OBSERVE = `window.__lcp = 0; window.__cls = 0;
new PerformanceObserver(list => { for (const e of list.getEntries()) __lcp = e.startTime }).observe({ type: 'largest-contentful-paint', buffered: true });
new PerformanceObserver(list => { for (const e of list.getEntries()) if (!e.hadRecentInput) __cls += e.value }).observe({ type: 'layout-shift', buffered: true });`

interface Sample {
  fcp: number
  lcp: number
  cls: number
  scripts: number
  load: number
}

const only = process.env.ONLY?.split('|')
const rewrites = Object.entries(REWRITES).filter(([name]) => !only || only.includes(name))

if (rewrites.length === 0)
  throw new Error(`ONLY names none of: ${Object.keys(REWRITES).join(' | ')}`)

const profile = PROFILES.find(candidate => candidate.name === (process.env.PROFILE ?? 'mobile'))!

async function load(browser: Browser, path: string, rewrite: (html: string) => string): Promise<Sample> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: profile.viewport, deviceScaleFactor: profile.dpr, isMobile: profile.mobile, hasTouch: profile.mobile })
  const page = await context.newPage()
  const session = await context.newCDPSession(page)

  await context.route(url => url.hostname !== 'localhost', async route => route.abort())
  await page.route(url => url.pathname === path, async (route) => {
    const response = await route.fetch()

    await route.fulfill({ response, body: rewrite(await response.text()) })
  })
  await page.addInitScript(OBSERVE)
  await session.send('Network.enable')
  await session.send('Network.setCacheDisabled', { cacheDisabled: true })
  await session.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latency, downloadThroughput: profile.down, uploadThroughput: profile.up })
  await session.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu })
  await page.goto(`https://localhost:${variant.ports.https}${path}`, { waitUntil: 'load' })

  const sample = await page.evaluate<Sample>(COLLECT)

  await context.close()

  return sample
}

const nginx = await startNginx()
const server = startServer(variant)
let browser: Browser | undefined

try {
  await waitReady(variant)
  browser = await chromium.launch({ headless: true })

  const samples = new Map<string, Sample[]>(rewrites.map(([name]) => [name, []]))

  for (let run = 0; run < RUNS; run++) {
    for (const path of PAGES) {
      for (const [name, rewrite] of rewrites)
        samples.get(name)!.push(await load(browser, path, rewrite))
    }

    console.error(`run ${run + 1}/${RUNS}`)
  }

  console.log(`${profile.name}, ${RUNS} runs over ${PAGES.join(' ')}, medians in ms`)
  console.log('| variant | first paint | largest paint | last script fetched | load | layout shift (max) |')
  console.log('| --- | --- | --- | --- | --- | --- |')

  for (const [name, list] of samples) {
    const middle = (key: keyof Sample) => median(list.map(sample => sample[key])).toFixed(0)

    console.log(`| ${name} | ${middle('fcp')} | ${middle('lcp')} | ${middle('scripts')} | ${middle('load')} | ${Math.max(...list.map(sample => sample.cls)).toFixed(3)} |`)
  }
}
finally {
  await browser?.close()
  server.kill()
  nginx.kill()
}
