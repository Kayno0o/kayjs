import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../src/build/index'
import { checkProject } from '../src/cli/check'
import { devServer } from '../src/dev/index'
import { createServer } from '../src/server/index'

const KAY_PKG_DIR = join(import.meta.dir, '..')
const tempDirs: string[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function linkKay(dir: string): void {
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(KAY_PKG_DIR, join(dir, 'node_modules/kay'), 'dir')
  symlinkSync(join(KAY_PKG_DIR, '../plugin-i18n'), join(dir, 'node_modules/@kayjs/i18n'), 'dir')
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('KayPlugin lifecycle hooks (check, watchPaths, addRouteStyle, addRouteHead) & @kayjs/spa (#3522)', () => {
  it('runs plugin check(ctx) hooks during kay check (including @kayjs/i18n missing keys)', async () => {
    const dir = makeTemp('kay-plugin-check-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      export default function Home() { return <h1>Hi</h1> }
    `)
    writeFileSync(join(dir, 'kay.config.ts'), `
      import { defineConfig } from 'kay/server'
      import { i18n } from '@kayjs/i18n'
      export default defineConfig({
        plugins: [
          i18n({
            locales: ['en', 'fr'],
            defaultLocale: 'en',
            messages: {
              en: { hello: 'Hello', bye: 'Goodbye' },
              fr: { hello: 'Bonjour' },
            },
          }),
          {
            name: 'custom-validator',
            check(ctx) {
              ctx.error('custom-validator: missing required manifest')
            },
          },
        ],
      })
    `)

    const res = await checkProject(dir, { skipTypecheck: true })
    expect(res.ok).toBe(false)
    expect(res.errors.some(e => e.includes('[i18n] fr: missing translation key "bye"'))).toBe(true)
    expect(res.errors.some(e => e.includes('custom-validator: missing required manifest'))).toBe(true)
  })

  it('applies BuildPluginContext.addRouteStyle() and addRouteHead() only to the target route', async () => {
    const dir = makeTemp('kay-route-hooks-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      export default function Home() { return <h1>Home</h1> }
    `)
    writeFileSync(join(dir, 'src/routes/pricing.tsx'), `
      export default function Pricing() { return <h1>Pricing</h1> }
    `)

    const routePlugin = {
      name: 'route-specific-plugin',
      build(ctx: import('../src/plugins/index').BuildPluginContext) {
        const href = ctx.emitAsset('pricing-extra.css', '.tier{font-weight:700}')
        ctx.addRouteStyle('/pricing', href)
        ctx.addRouteHead('/pricing', '<meta name="pricing-tier" content="pro">')
      },
    }

    await build({ root: dir, plugins: [routePlugin] })
    const app = await createServer({ root: dir, plugins: [routePlugin] })

    const homeHtml = await (await app.handle(new Request('http://localhost/'))).text()
    expect(homeHtml).not.toContain('pricing-extra.css')
    expect(homeHtml).not.toContain('pricing-tier')

    const pricingHtml = await (await app.handle(new Request('http://localhost/pricing'))).text()
    expect(pricingHtml).toContain('pricing-extra.css')
    expect(pricingHtml).toContain('<meta name="pricing-tier" content="pro">')
  })

  it('watches plugin-declared watchPaths in kay dev and rebuilds on change', async () => {
    const dir = makeTemp('kay-watch-paths-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'content'), { recursive: true })

    const notePath = join(dir, 'content/banner.txt')
    writeFileSync(notePath, 'Initial Banner')
    writeFileSync(join(dir, 'kay.config.ts'), `
      import { defineConfig } from 'kay/server'
      export default defineConfig({
        plugins: [{ name: 'content-watch', watchPaths: ['content'] }],
      })
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { readFileSync } from 'node:fs'
      export default function Home() {
        return <p>{readFileSync(${JSON.stringify(notePath)}, 'utf8')}</p>
      }
    `)

    const srv = await devServer({ root: dir, port: 0 })
    const ac = new AbortController()
    try {
      expect(await (await fetch(`${srv.url}/`)).text()).toContain('Initial Banner')

      const sseRes = await fetch(`${srv.url}/_kay/dev-events`, { signal: ac.signal })
      const reader = sseRes.body!.getReader()
      const dec = new TextDecoder()

      await Bun.sleep(60)
      writeFileSync(notePath, 'Updated Banner')

      let buf = ''
      const deadline = Date.now() + 4000
      while (!buf.includes('data: reload') && Date.now() < deadline) {
        const { done, value } = await reader.read()
        if (done)
          break
        buf += dec.decode(value)
      }
      expect(buf).toContain('data: reload')
      expect(await (await fetch(`${srv.url}/`)).text()).toContain('Updated Banner')
    }
    finally {
      ac.abort()
      srv.stop()
    }
  })

  it('supports @kayjs/spa head stylesheet/meta diffing, AbortController cancellation, and prefetch cache', async () => {
    GlobalRegistrator.register({ url: 'http://localhost/', settings: { handleDisabledFileLoadingAsSuccess: true } })
    const origFetch = globalThis.fetch
    let fetchCount = 0
    try {
      document.documentElement.setAttribute('lang', 'en')
      document.head.innerHTML = [
        '<title>Home</title>',
        '<link rel="stylesheet" href="/_kay/shared.css">',
        '<link rel="stylesheet" href="/_kay/home.css">',
        '<meta name="description" content="Home desc">',
        '<link rel="canonical" href="http://localhost/">',
      ].join('')
      document.body.innerHTML = '<main>Home body</main><div data-persist="player" id="keep">LIVE</div>'

      // Stub fetch for /about, /slow, /fast
      const pages: Record<string, string> = {
        'http://localhost/about': `<!DOCTYPE html><html lang="fr"><head><title>About</title><link rel="stylesheet" href="/_kay/shared.css"><link rel="stylesheet" href="/_kay/about.css"><meta name="description" content="About desc"><link rel="canonical" href="http://localhost/about"></head><body><main>About body</main><div data-persist="player">REPLACED</div><section id="sec">Anchor</section></body></html>`,
        'http://localhost/fast': `<!DOCTYPE html><html lang="en"><head><title>Fast</title><link rel="stylesheet" href="/_kay/shared.css"></head><body><main>Fast Wins</main></body></html>`,
      }

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        fetchCount++
        if (url === 'http://localhost/slow') {
          return await new Promise<Response>((resolve, reject) => {
            const t = setTimeout(() => {
              resolve(new Response('<html><head><title>Slow</title></head><body>Slow</body></html>', {
                headers: { 'content-type': 'text/html' },
              }))
            }, 250)
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(t)
              reject(new DOMException('Aborted', 'AbortError'))
            }, { once: true })
          })
        }
        const html = pages[url] ?? '<html><body>404</body></html>'
        const res = new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
        Object.defineProperty(res, 'url', { value: url })
        return res
      }) as typeof fetch

      // Auto-resolve stylesheet load events in Happy-DOM so prepareHeadStyles completes instantly
      const origAppend = document.head.appendChild.bind(document.head)
      document.head.appendChild = ((node: Node) => {
        const res = origAppend(node)
        if ((node as HTMLElement).tagName === 'LINK' && (node as HTMLLinkElement).rel === 'stylesheet')
          queueMicrotask(() => node.dispatchEvent(new Event('load')))
        return res
      }) as typeof document.head.appendChild

      const spa = await import('../../plugin-spa/src/client')

      // 1. Prefetch /about -> caches HTML, so navigate('/about') issues 0 extra fetches
      await spa.prefetch('http://localhost/about')
      expect(fetchCount).toBe(1)

      await spa.navigate('http://localhost/about#sec', true)
      expect(fetchCount).toBe(1) // Served straight from prefetch cache!
      expect(document.title).toBe('About')
      expect(document.documentElement.getAttribute('lang')).toBe('fr')
      expect(document.body.textContent).toContain('About body')
      // Persisted element survived intact!
      expect(document.getElementById('keep')?.textContent).toBe('LIVE')
      // Head diffing: shared.css kept, home.css removed, about.css added, meta & canonical synced!
      const hrefs = [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(l => l.getAttribute('href'))
      expect(hrefs).toEqual(['/_kay/shared.css', '/_kay/about.css'])
      expect(document.head.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('About desc')
      expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('http://localhost/about')

      // 2. AbortController cancellation: /slow started then immediately superseded by /fast
      const pSlow = spa.navigate('http://localhost/slow', true)
      const pFast = spa.navigate('http://localhost/fast', true)
      await Promise.all([pSlow, pFast])
      expect(document.title).toBe('Fast')
      expect(document.body.textContent).toContain('Fast Wins')
    }
    finally {
      globalThis.fetch = origFetch
      await GlobalRegistrator.unregister()
    }
  })
})
