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
import { outputDir } from '../src/build/assets'
import { styledClassNames } from '../src/build/class-rules'
import { buildClient } from '../src/build/client'
import { parse } from '../src/build/supports'
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
  // A failure and a missing page have chains of their own, and a page rendering a collection's Markdown may name any class.
  await Bun.write(join(dir, 'src/routes/_404.kay'), 'h1 Gone\np.italic nothing here\n')
  await Bun.write(join(dir, 'src/routes/_error.kay'), 'h1 Broken\np.tracking-wide went wrong\n')
  await Bun.write(join(dir, 'src/routes/boom.kay'), '--- server\nthrow new Error(\'boom\')\n---\nh1 Boom\n')
  await Bun.write(join(dir, 'src/content.config.ts'), 'import { s } from \'kay\'\nimport { collection } from \'kay/content\'\n\nexport const notes = collection(\'content/notes\', { schema: s.Object({ title: s.String() }) })\n')
  await Bun.write(join(dir, 'src/content/notes/first.md'), '---\ntitle: First\n---\n\nHello\n')
  await Bun.write(join(dir, 'src/routes/notes.kay'), '--- server\nimport { notes } from \'../content.config\'\n\nconst { Content } = (await notes.get(\'first\'))!\n---\nh1 Notes\nContent\n')

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

// Whether the rules written inline hold one for the class, as the class attribute writes it: `data-[state=open]:flex`.
function styles(css: string, name: string): boolean {
  return styledClassNames(parse(css)).has(name)
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
    // After the inline rules, so a rule only the shared stylesheet holds keeps the place it has in the whole stylesheet.
    expect(about.html.lastIndexOf('<style>')).toBeLessThan(about.html.indexOf(about.rest[0]!))

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

  it('carries the rules of static classes whose names hold quotes, equals signs and angle brackets', async () => {
    const rules = await head(await serve(), '/static')

    for (const name of ['data-[state=open]:bg-red-500', '[&>svg]:size-4', 'font-[\'Fira_Code\']', 'has-[>img]:p-2', 'after:content-[\'x\']', '2xl:p-4'])
      expect(styles(rules.styles, name), name).toBe(true)
  })

  it('writes the shared stylesheet after the inline rules, so a tie between them goes as in the whole stylesheet', async () => {
    const tie = await head(await serve(), '/tie')

    expect(styles(tie.styles, 'text-sm')).toBe(true)
    expect(styles(tie.styles, 'text-xl')).toBe(false)
    expect(tie.html.indexOf(tie.rest[0]!)).toBeGreaterThan(tie.html.lastIndexOf('</style>'))
    expect(tie.html.indexOf(REST_SCRIPT)).toBeGreaterThan(tie.html.indexOf(tie.rest[0]!))
    expect(await sharedText(client, tie.rest[0]!)).toContain('.text-xl')
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

  it('links the stylesheets whole for a page rendering a collection\'s Markdown, which may name any class', async () => {
    const notes = await head(await serve(), '/notes')

    expect(notes.blocking).toHaveLength(1)
    expect(notes.rest).toEqual([])
    expect(notes.html).not.toContain('data-kay-rest')
  })

  it('writes the head of the missing page and of the error page as any page\'s', async () => {
    const app = await serve()
    const missing = await app.handle(new Request('http://localhost/nowhere'))
    const failed = await app.handle(new Request('http://localhost/boom'))

    expect(missing.status).toBe(404)
    expect(failed.status).toBe(500)

    for (const [response, rule, other] of [[missing, 'italic', 'tracking-wide'], [failed, 'tracking-wide', 'italic']] as const) {
      const html = await response.text()
      const inline = [...html.matchAll(STYLE)].map(match => match[1]!).join('\n')

      expect(hasRule(inline, rule), rule).toBe(true)
      expect(hasRule(inline, other), other).toBe(false)
      expect(html).toContain('data-kay-rest')
      expect(html).toMatch(/<noscript><link rel="stylesheet" href="\/_kay\/[^"]+"><\/noscript>/)
    }
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
    expect(html).toMatch(new RegExp(`<noscript><link rel="stylesheet" href="${base ?? ''}/_kay/[^"]+"></noscript>`))
    expect(policy).toContain(sourceHash(REST_SCRIPT))
    // A style several pages share is let through once.
    const hashes = policy.match(/'sha256-[^']+'/g)!

    expect(new Set(hashes).size).toBe(hashes.length)

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

    const file = await Bun.file(join(outputDir(root), 'pages/prerendered.html')).text()
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

describe('a page kept at build time under a mount point', () => {
  it('carries the mount point in the href of its noscript and of its linked stylesheet', async () => {
    const built = await buildClient(root, { plugins: [tailwind], base: '/docs' })

    expect(await prerenderPages(resolveProject(root, { routes: 'src/routes', base: '/docs' }, PRODUCTION), built)).toBeGreaterThan(0)

    const file = await Bun.file(join(outputDir(root), 'pages/prerendered.html')).text()

    expect(file).toContain('data-kay-rest')
    expect(file).toMatch(/<link rel="stylesheet" href="\/docs\/_kay\/[^"]+" media="print" data-kay-rest>/)
    expect(file).toMatch(/<noscript><link rel="stylesheet" href="\/docs\/_kay\/[^"]+"><\/noscript>/)
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

  it('keeps a noscript whose markup holds an ampersand through a swap, as the server serves it', async () => {
    const page = await browser.newPage()

    // Both pages carry the same noscript, as a layout's would.
    await page.route(`${origin}/**`, async (route) => {
      try {
        const response = await route.fetch()
        const html = (response.headers()['content-type'] ?? '').includes('text/html')

        await route.fulfill(html ? { response, body: (await response.text()).replace('</head>', '<noscript><link rel="stylesheet" href="/amp.css?a=1&b=2"></noscript></head>') } : { response })
      }
      catch {
        // The page closed with this request on its way.
      }
    })
    await page.goto(`${origin}/`)
    await page.evaluate(() => {
      (window as { kept?: HTMLElement | undefined }).kept = [...document.head.querySelectorAll('noscript')].find(element => element.textContent?.includes('a=1&b=2'))
    })
    expect(await page.evaluate(() => (window as { kept?: HTMLElement | undefined }).kept !== undefined)).toBe(true)
    await page.click('a.about')
    await page.locator('h1', { hasText: 'About' }).waitFor()
    expect(await page.evaluate(() => [...document.head.querySelectorAll('noscript')].includes((window as { kept?: HTMLElement | undefined }).kept!))).toBe(true)
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await page.close()
  })

  it('drops the shared stylesheet of the layout it leaves, and keeps the new inline rules ahead of the one it keeps', async () => {
    const page = await browser.newPage()

    await page.goto(`${origin}/ga/pa`)
    await page.waitForFunction(() => [...document.head.querySelectorAll<HTMLLinkElement>('link[data-kay-rest]')].every(link => link.media === 'all'))

    const before = await page.evaluate(() => [...document.head.querySelectorAll('link[data-kay-rest]')].map(link => link.getAttribute('href')))

    expect(before.length).toBeGreaterThan(1)
    await page.click('a.to-b')
    await page.locator('h1', { hasText: 'Page B' }).waitFor()

    const after = await page.evaluate(() => [...document.head.querySelectorAll('link[data-kay-rest]')].map(link => link.getAttribute('href')))
    const direct = await browser.newPage()

    await direct.goto(`${origin}/gb/pb`)

    const expected = await direct.evaluate(() => [...document.head.querySelectorAll('link[data-kay-rest]')].map(link => link.getAttribute('href')))

    expect(after.toSorted()).toEqual(expected.toSorted())
    expect(await page.evaluate(() => document.head.querySelectorAll('noscript').length)).toBe(await direct.evaluate(() => document.head.querySelectorAll('noscript').length))
    // Every inline style sits before the first shared stylesheet.
    expect(await page.evaluate(() => {
      const children = [...document.head.children]
      const first = children.findIndex(element => element.matches('link[data-kay-rest]'))

      return children.slice(first).some(element => element.tagName === 'STYLE')
    })).toBe(false)
    await direct.close()
    await page.close()
  })

  it('lets a rule only the shared stylesheet holds win a tie against an inline one, as in the whole stylesheet', async () => {
    const page = await browser.newPage()

    await page.goto(`${origin}/tie`)
    await page.waitForFunction(() => document.querySelector<HTMLLinkElement>('link[data-kay-rest]')?.media === 'all')
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.tie')!).fontSize === '20px')
    await page.close()
  })
})
