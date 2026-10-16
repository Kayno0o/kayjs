import type { Browser, Page } from 'playwright-core'
import type { PagesOptions } from '../src/server/app'
import type { ClientBuild } from '../src/server/client'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { buildClient } from '../src/build/client'
import { modeOf, PRODUCTION, resolveProject } from '../src/project'
import { servePages } from '../src/server/app'
import { INLINE_LIMIT, readClient, readInlineStyles } from '../src/server/client'
import { sourceHash } from '../src/server/csp'
import { prerenderPages } from '../src/server/prerender'
import { fixtureCopy } from './scratch'

// Many arbitrary values, each its own rule, so the app's one stylesheet passes what a head may inline.
const BULK = Array.from({ length: 1800 }, (_, index) => `bg-[#${((index * 2654435761) >>> 8).toString(16).padStart(6, '0').slice(0, 6)}] p-[${index + 3}px]`).join(' ')
const LISTENING = /port (\d+)/
const STYLE = /<style>([\s\S]*?)<\/style>/g
const REST_SCRIPT = 'for(const l of document.querySelectorAll("link[data-kay-rest]"))l.media="all"'
const executablePath = process.env.BUN_CHROME_PATH !== undefined && process.env.BUN_CHROME_PATH !== '' ? process.env.BUN_CHROME_PATH : chromium.executablePath()
const browserInstalled = existsSync(executablePath)

let root = ''
let client: ClientBuild

type App = Awaited<ReturnType<typeof servePages>>

// A copy of the fixture with a page whose own rules pass the limit, built with Tailwind.
async function copyOfFixture(): Promise<string> {
  const dir = resolve(await fixtureCopy('page-styles'))

  await Bun.write(join(dir, 'src/routes/bulk.kay'), `h1 Bulk\np(class="${BULK}") bulk\n`)

  return dir
}

// The heads a server writes are kept per `styles` map, so each server gets a map of its own.
async function serve(options: PagesOptions & { dev?: boolean } = {}, built = client): Promise<App> {
  const mode = modeOf({ dev: options.dev ?? false, prebuilt: options.dev !== true })
  const config = { routes: 'src/routes', compress: false, ...options }

  return servePages(resolveProject(root, config, mode), () => ({ ...built, styles: new Map(built.styles), inlineStyles: undefined, inlineSizes: undefined, pageStyles: undefined }))
}

interface Head {
  html: string
  styles: string
  // The stylesheets linked as they hold the first paint back.
  blocking: string[]
  // The shared stylesheet, which applies once the page is up.
  rest: string[]
}

async function head(app: App, path: string): Promise<Head> {
  const response = await app.handle(new Request(`http://localhost${path}`))
  const html = await response.text()

  return {
    html,
    styles: [...html.matchAll(STYLE)].map(match => match[1]!).join('\n'),
    blocking: [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => match[1]!).filter(href => !html.includes(`<noscript><link rel="stylesheet" href="${href}"></noscript>`)),
    rest: [...html.matchAll(/<link rel="stylesheet" href="([^"]+)" media="print" data-kay-rest>/g)].map(match => match[1]!),
  }
}

// Whether the rules written inline hold one for the class.
function hasRule(styles: string, name: string): boolean {
  return styles.includes(`.${name.replaceAll(':', '\\:').replaceAll('/', '\\/')}`)
}

async function sharedText(built: ClientBuild, url: string): Promise<string> {
  return Bun.file(join(built.dir, url.slice('/_kay/'.length))).text()
}

beforeAll(async () => {
  root = await copyOfFixture()
  client = await buildClient(root, { plugins: [tailwind] })
}, 120_000)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('a page\'s head', () => {
  it('is built from a stylesheet past what a head inlines', async () => {
    const sizes = [...(await readInlineStyles(client, '')).values()].map(css => Bun.gzipSync(css).length)

    expect(Math.max(...sizes)).toBeGreaterThan(INLINE_LIMIT)
  })

  it('carries the rules its own components use, and links the shared stylesheet for the rest without holding the first paint', async () => {
    const about = await head(await serve(), '/about')

    expect(about.blocking).toEqual([])
    expect(about.rest).toHaveLength(1)
    expect(about.html).toContain(`<noscript><link rel="stylesheet" href="${about.rest[0]}"></noscript>`)
    expect(about.html).toContain(`<script data-kay-rest>${REST_SCRIPT}</script>`)
    expect(about.html.indexOf(about.rest[0]!)).toBeLessThan(about.html.indexOf('<style>'))

    // The layout's own, the page's component, and the stylesheet's hand-written rule.
    for (const name of ['px-4', 'font-bold', 'underline', 'decoration-wavy', 'mark'])
      expect(hasRule(about.styles, name), name).toBe(true)

    for (const name of ['text-red-500', 'md:flex', 'bg-lime-300', 'border-red-500', 'ring-4'])
      expect(hasRule(about.styles, name), name).toBe(false)

    const shared = await sharedText(client, about.rest[0]!)

    for (const name of ['underline', 'text-red-500', 'bg-lime-300', 'ring-4'])
      expect(shared).toContain(`.${name}`)
  })

  it('leaves out the rules of a component only another page renders', async () => {
    const app = await serve()
    const home = await head(app, '/')
    const about = await head(app, '/about')
    const widgets = await head(app, '/widgets')

    expect(hasRule(home.styles, 'text-red-500')).toBe(true)
    expect(hasRule(home.styles, 'md:flex')).toBe(true)
    expect(hasRule(home.styles, 'underline')).toBe(false)
    expect(hasRule(about.styles, 'underline')).toBe(true)
    expect(hasRule(about.styles, 'bg-lime-300')).toBe(false)
    expect(hasRule(widgets.styles, 'underline')).toBe(false)
  })

  it('carries the rules of a component rendered only inside an island', async () => {
    const widgets = await head(await serve(), '/widgets')

    expect(widgets.html).toContain('<script type="module"')
    expect(hasRule(widgets.styles, 'bg-lime-300')).toBe(true)
  })

  it('carries the rule of a class its page builds from a template string', async () => {
    const dynamic = await head(await serve(), '/dynamic')

    expect(hasRule(dynamic.styles, 'border-red-500')).toBe(true)
  })

  it('leaves the rule of a class nothing on the page writes to the shared stylesheet, which every page links', async () => {
    const data = await head(await serve(), '/data')

    expect(hasRule(data.styles, 'ring-4')).toBe(false)
    expect(data.rest).toHaveLength(1)
    expect(await sharedText(client, data.rest[0]!)).toContain('.ring-4')
  })

  it('links the stylesheets whole when its own rules pass the limit too', async () => {
    const bulk = await head(await serve(), '/bulk')

    expect(bulk.styles).toBe('')
    expect(bulk.blocking).toHaveLength(1)
    expect(bulk.rest).toEqual([])
    expect(bulk.html).not.toContain('data-kay-rest')
  })

  it.each([undefined, '/docs'])('goes out under the mount point %s, each rule let through a strict style-src by its hash and compressed whole', async (base) => {
    const built = base === undefined ? client : await buildClient(root, { plugins: [tailwind], base })
    const security = { csp: { 'style-src': ['\'self\''] } }
    // A proxy strips the mount point before the request reaches the server.
    const path = '/about'
    const plain = await (await serve({ base, security }, built)).handle(new Request(`http://localhost${path}`))
    const html = await plain.text()
    const policy = plain.headers.get('content-security-policy')!
    const styles = [...html.matchAll(STYLE)].map(match => match[1]!)

    expect(styles.length).toBeGreaterThan(0)
    for (const style of styles)
      expect(policy).toContain(sourceHash(style))

    expect(html).toContain(`<link rel="stylesheet" href="${base ?? ''}/_kay/`)
    expect(policy).toContain(sourceHash(REST_SCRIPT))

    const compressed = await (await serve({ base, security, compress: true }, built)).handle(new Request(`http://localhost${path}`, { headers: { 'accept-encoding': 'br, gzip' } }))

    expect(compressed.headers.get('content-encoding')).toBe('gzip')
    expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await compressed.arrayBuffer())))).toBe(html)
  })

  it('stays as it was for inlineStyles true and false, and in development', async () => {
    const forced = await head(await serve({ inlineStyles: true }), '/about')
    const linked = await head(await serve({ inlineStyles: false }), '/about')
    const dev = await head(await serve({ dev: true }), '/about')

    expect(forced.html).not.toContain('data-kay-rest')
    expect(hasRule(forced.styles, 'bg-lime-300')).toBe(true)
    expect(linked.html).not.toContain('<style>')
    expect(linked.html).not.toContain('data-kay-rest')
    expect(linked.blocking).toHaveLength(1)
    expect(dev.html).not.toContain('data-kay-rest')
    expect(dev.html).not.toContain('<style>')
  })

  it('is written into a page kept at build time, its hash known to the server that serves it', async () => {
    expect(await prerenderPages(resolveProject(root, { routes: 'src/routes' }, PRODUCTION), client)).toBeGreaterThan(0)

    const file = await Bun.file(join(root, '.kay/client/pages/prerendered.html')).text()
    const styles = [...file.matchAll(STYLE)].map(match => match[1]!).join('\n')

    expect(file).toContain('data-kay-rest')
    expect(hasRule(styles, 'underline')).toBe(true)
    expect(hasRule(styles, 'bg-lime-300')).toBe(false)

    const served = await servePages(resolveProject(root, { routes: 'src/routes', security: { csp: { 'style-src': ['\'self\''] } } }, PRODUCTION), async () => (await readClient(root))!)
    const response = await served.handle(new Request('http://localhost/prerendered'))
    const body = await response.text()

    expect(body).toBe(file)
    for (const [, style] of body.matchAll(STYLE))
      expect(response.headers.get('content-security-policy')).toContain(sourceHash(style!))
  }, 120_000)
})

describe.skipIf(!browserInstalled && (process.env.CI ?? '') === '')('the page swap, in Chromium', () => {
  let server: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  let browser: Browser
  let origin: string
  let appDir = ''

  beforeAll(async () => {
    appDir = await copyOfFixture()
    server = Bun.spawn(['bun', 'server.ts'], { cwd: appDir, env: { ...process.env, NODE_ENV: 'production' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

    const reader = server.stdout.getReader()
    let output = ''

    for (let match = LISTENING.exec(output); !match; match = LISTENING.exec(output)) {
      const { value, done } = await reader.read()

      if (done)
        throw new Error(`the fixture exited without listening: ${await new Response(server.stderr).text()}`)

      output += new TextDecoder().decode(value)
    }

    reader.releaseLock()
    origin = `http://localhost:${LISTENING.exec(output)![1]}`
    browser = await chromium.launch({ headless: true, executablePath })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    server?.kill()
    await server?.exited
    await rm(appDir, { recursive: true, force: true })
  })

  const style = async (page: Page, selector: string, property: 'textDecorationLine' | 'boxShadow' | 'backgroundColor') => page.evaluate(([selector, property]) => getComputedStyle(document.querySelector(selector!)!)[property as 'boxShadow'], [selector, property])
  const inlined = async (page: Page) => page.evaluate(() => [...document.head.querySelectorAll('style')].map(element => element.textContent).join('\n'))

  it('applies the shared stylesheet once the page is up, and the rules only that stylesheet holds', async () => {
    const page = await browser.newPage()

    await page.goto(`${origin}/data`)
    await page.waitForFunction(() => document.querySelector<HTMLLinkElement>('link[data-kay-rest]')?.media === 'all')
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.tone')!).boxShadow !== 'none')
    expect(await style(page, '.tone', 'boxShadow')).not.toBe('none')
    await page.close()
  })

  it('brings the rules the next page needs with the swap, from a page to one using a component the first does not', async () => {
    const page = await browser.newPage()

    await page.goto(`${origin}/`)
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    expect(await inlined(page)).not.toContain('.decoration-wavy')
    await page.click('a.about')
    await page.locator('h1', { hasText: 'About' }).waitFor()
    expect(await inlined(page)).toContain('.decoration-wavy')
    expect(await style(page, '.fancy', 'textDecorationLine')).toBe('underline')
    expect(await page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
    // One shared stylesheet through the swap, applied and never added twice.
    expect(await page.evaluate(() => [...document.head.querySelectorAll<HTMLLinkElement>('link[data-kay-rest]')].map(link => link.media))).toEqual(['all'])
    await page.click('a.widgets')
    await page.locator('h1', { hasText: 'Widgets' }).waitFor()
    expect(await inlined(page)).toContain('.bg-lime-300')
    expect(await inlined(page)).not.toContain('.decoration-wavy')
    expect(await style(page, '.counter', 'backgroundColor')).not.toBe('rgba(0, 0, 0, 0)')
    expect(await page.evaluate(() => document.head.querySelectorAll('link[data-kay-rest]').length)).toBe(1)
    await page.goBack()
    await page.locator('h1', { hasText: 'About' }).waitFor()
    expect(await style(page, '.fancy', 'textDecorationLine')).toBe('underline')
    await page.close()
  })
})
