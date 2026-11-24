import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { i18n } from '../../plugin-i18n/src/index'
import { spa } from '../../plugin-spa/src/index'
import { tailwind } from '../../plugin-tailwind/src/index'
import { definePlugin } from '../src/plugins/index'
import { testApp } from '../src/test/index'

const fixtureDir = mkdtempSync(join(tmpdir(), 'kay-v2-plugins-'))

function writeFixture(rel: string, content: string): void {
  const abs = join(fixtureDir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

writeFixture('src/app.css', `
body { font-family: system-ui, sans-serif; }
.badge { color: #2563eb; }
`)

writeFixture('src/components/Counter.tsx', `
import { signal } from 'kay'

export function Counter() {
  const count = signal(0)
  return <button class="counter" onClick={() => count.value++}>Count {count.value}</button>
}
`)

writeFixture('src/routes/_layout.tsx', `
import type { KayChild } from 'kay'
import { Counter } from '../components/Counter'

export default function Layout({ children }: { children?: KayChild }) {
  return (
    <div>
      <nav>
        <a href="/">Home</a>
        <a href="/about">About</a>
        <a href="/raw" data-no-localize>Raw</a>
      </nav>
      <div data-persist="shared-counter"><Counter /></div>
      <main>{children}</main>
    </div>
  )
}
`)

writeFixture('src/routes/index.tsx', `
import { Head } from 'kay'

export default function Home({ locals }: { locals: Record<string, unknown> }) {
  const t = locals.t as (k: string) => string
  return (
    <>
      <Head><title>Home</title></Head>
      <h1>{t('welcome')}</h1>
    </>
  )
}
`)

writeFixture('src/routes/about.tsx', `
import { Head } from 'kay'

export default function About({ locals }: { locals: Record<string, unknown> }) {
  const t = locals.t as (k: string) => string
  return (
    <>
      <Head><title>About</title></Head>
      <h1>{t('about')}</h1>
      <p>TRANSFORM_TOKEN</p>
    </>
  )
}
`)

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
})

describe('KayPlugin API (tailwind + i18n + spa + custom transform)', () => {
  test('composes CSS bundling, i18n locale rewriting/routes, custom transform, and SPA navigation with persistent islands', async () => {
    const customBannerPlugin = definePlugin({
      name: 'custom-banner',
      transform(code, _id, target) {
        if (target === 'server' && code.includes('TRANSFORM_TOKEN'))
          return code.replace('TRANSFORM_TOKEN', 'Transformed by plugin!')
        return undefined
      },
      server(api) {
        api.use(async (_ctx, next) => {
          const res = await next()
          res.headers.set('x-plugin-mw', 'active')
          return res
        })
      },
    })

    const plugins = [
      tailwind({ css: 'src/app.css' }),
      i18n({
        locales: ['en', 'fr'],
        defaultLocale: 'en',
        messages: {
          en: { welcome: 'Welcome', about: 'About Us' },
          fr: { welcome: 'Bienvenue', about: 'À propos' },
        },
      }),
      spa(),
      customBannerPlugin,
    ]

    const app = await testApp({ root: fixtureDir, plugins })

    // 1. Default English route: CSS stylesheet linked, global middleware active, runtime script loaded
    const enRes = await app.get('/')
    expect(enRes.status).toBe(200)
    expect(enRes.headers.get('x-plugin-mw')).toBe('active')
    const enHtml = await enRes.text()
    expect(enHtml).toContain('<html lang="en">')
    expect(enHtml).toContain('<h1>Welcome</h1>')
    expect(enHtml).toMatch(/<link rel="stylesheet" href="\/_kay\/app-[^"]+\.css">/)
    expect(enHtml).toMatch(/<script type="module" src="\/_kay\/runtime-[^"]+\.js">/)

    // Verify bundled CSS is served cleanly
    const cssMatch = /href="(\/_kay\/app-[^"]+\.css)"/.exec(enHtml)
    expect(cssMatch).not.toBeNull()
    const cssRes = await app.get(cssMatch![1]!)
    expect(cssRes.status).toBe(200)
    expect(await cssRes.text()).toContain('.badge')

    // 2. French localized route via @kayjs/i18n rewrite + transformHtml + custom transform plugin
    const frRes = await app.get('/fr/about')
    expect(frRes.status).toBe(200)
    const frHtml = await frRes.text()
    expect(frHtml).toContain('<html lang="fr">')
    expect(frHtml).toContain('<h1>À propos</h1>')
    expect(frHtml).toContain('<p>Transformed by plugin!</p>')
    expect(frHtml).toContain('href="/fr"')
    expect(frHtml).toContain('href="/fr/about"')
    expect(frHtml).toContain('href="/raw"') // data-no-localize respected!

    // 3. Custom route registered by @kayjs/i18n via api.route()
    const localesRes = await app.get('/_i18n/locales')
    expect(localesRes.status).toBe(200)
    expect(await localesRes.json()).toEqual({ locales: ['en', 'fr'], defaultLocale: 'en', current: 'en' })

    // 4. Verify @kayjs/spa client script is bundled and preserves persistent island state across navigation in Chromium!
    const allClientJs = app.manifest!.assets
      .filter(f => f.endsWith('.js'))
      .map(f => readFileSync(join(fixtureDir, 'dist/client', f), 'utf8'))
      .join('\n')
    expect(allClientJs).toContain('x-kay-spa')

    const chromePath = process.env.BUN_CHROME_PATH || chromium.executablePath()
    if (existsSync(chromePath)) {
      const server = app.app.serve(0)
      const browser = await chromium.launch({ headless: true, executablePath: chromePath })
      try {
        const page = await browser.newPage()
        await page.goto(`http://localhost:${server.port}/`, { waitUntil: 'networkidle' })

        // Increment persistent counter island on Home
        await page.click('button.counter')
        await page.click('button.counter')
        expect(await page.textContent('button.counter')).toBe('Count 2')

        // Click SPA link to /about (in-place navigation!)
        await page.click('a[href="/about"]')
        await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'About Us')

        // Persistent counter kept its live state (Count 2) AND remains interactive!
        expect(await page.textContent('button.counter')).toBe('Count 2')
        await page.click('button.counter')
        expect(await page.textContent('button.counter')).toBe('Count 3')
        expect(page.url()).toEndWith('/about')
      }
      finally {
        await browser.close()
        server.stop(true)
      }
    }
  })
})
