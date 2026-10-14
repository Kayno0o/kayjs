import type { ClientBuild } from '../src/server/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { inlineScriptHashes, pages } from '../src/server'
import { registerScript, serveServiceWorker } from '../src/server/offline'
import { ServedPaths } from '../src/server/served-paths'

const ROUTES = 'tests/fixtures/static/src/routes'
const SETTINGS = /^const KAY = (.+)$/m

interface WorkerSettings {
  cache: string
  precache: string[]
  files: string[]
  pages: string[]
  fallback?: string
  network: string[]
}

// The policy source letting the registration of a worker under `base` run.
function registerHash(base: string): string {
  return `'sha256-${new Bun.CryptoHasher('sha256').update(registerScript(base).slice('<script>'.length, -'</script>'.length)).digest('base64')}'`
}

async function worker(app: { handle: (request: Request) => Promise<Response> }): Promise<{ text: string, settings?: WorkerSettings | undefined, headers: Headers }> {
  const response = await app.handle(new Request('http://localhost/sw.js'))
  const text = await response.text()
  const settings = SETTINGS.exec(text)?.[1]

  return { text, settings: settings === undefined ? undefined : JSON.parse(settings) as WorkerSettings, headers: response.headers }
}

describe('service worker', () => {
  it('stays off by default: no registration, no hash for it, and a worker at /sw.js that removes itself', async () => {
    const app = await pages({ routes: ROUTES, prebuilt: false, site: 'https://x.example' })
    const page = await (await app.handle(new Request('http://localhost/about'))).text()
    const { text, settings, headers } = await worker(app)

    expect(page).not.toContain('serviceWorker')
    expect(headers.get('content-security-policy')).not.toContain(registerHash(''))
    expect(inlineScriptHashes({ offline: true })).toContain(registerHash(''))
    expect(settings).toBeUndefined()
    expect(text).toContain('self.registration.unregister()')
    expect(headers.get('cache-control')).toBe('no-cache')
  })

  it('registers a worker under the base keeping the build\'s files and the pages listed, its hash in the policy', async () => {
    const app = await pages({ routes: ROUTES, prebuilt: false, site: 'https://x.example', base: '/repo', offline: { pages: ['/', '/about'], fallback: '/about' } })
    const page = await app.handle(new Request('http://localhost/about'))
    const { settings, headers } = await worker(app)
    const script = registerScript('/repo')

    expect(await page.text()).toContain(script)
    expect(page.headers.get('content-security-policy')).toContain(registerHash('/repo'))
    expect(headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(settings!.cache).toMatch(/^kay-\w+$/)
    expect(settings!.pages).toEqual(['/repo/', '/repo/about'])
    expect(settings!.fallback).toBe('/repo/about')
    expect(settings!.network).toEqual(['/repo/_kay/', '/repo/api/'])
    expect(settings!.files.every(file => file.startsWith('/repo/_kay/') && !file.endsWith('.br') && !file.endsWith('.gz') && !file.endsWith('.map'))).toBe(true)
    expect(settings!.precache).toContain(settings!.files.find(file => file.endsWith('.js'))!)
    // Of the assets, only scripts, such as the worker kay's script solves an action's proof-of-work in.
    expect(settings!.precache.filter(file => file.includes('/assets/') && !file.endsWith('.js'))).toEqual([])
    expect(settings!.precache).toEqual(expect.arrayContaining(['/repo/', '/repo/about']))

    const dev = await pages({ routes: ROUTES, prebuilt: false, site: 'https://x.example', dev: true, offline: true })

    expect(await (await dev.handle(new Request('http://localhost/about'))).text()).not.toContain('serviceWorker')
    expect((await worker(dev)).text).toContain('self.registration.unregister()')
  })

  it('names its cache after the build, so a deploy installs a worker that drops the old one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-sw-'))
    const build = async (files: string[], etag = '"a"') => {
      for (const file of files)
        await Bun.write(join(dir, file), file)

      const app = new Elysia()
      const client = { dir, pages: new Map([['/', { pattern: '/', file: 'index.html', status: 200, headers: {}, etag, renderedAt: 0 }]]) } as unknown as ClientBuild

      await serveServiceWorker(app, new ServedPaths(), { client, offline: true, base: '', publicPages: ['/'] })

      return (await worker(app)).settings!
    }

    try {
      const first = await build(['entry-a.js', 'app-a.css', 'assets/hero-a.png', 'entry-a.js.br'])

      expect(first.files).toEqual(['/_kay/app-a.css', '/_kay/assets/hero-a.png', '/_kay/entry-a.js'])
      expect(first.pages).toEqual(['/'])
      expect((await build([])).cache).toBe(first.cache)
      expect((await build([], '"b"')).cache).not.toBe(first.cache)
      expect((await build(['entry-b.js'])).cache).not.toBe(first.cache)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
