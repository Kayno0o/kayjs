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

  it('stays off with offline: false from a JS config', async () => {
    const app = await pages({ routes: ROUTES, prebuilt: false, site: 'https://x.example', offline: false })
    const page = await app.handle(new Request('http://localhost/about'))
    const { text, settings, headers } = await worker(app)

    expect(await page.text()).not.toContain('serviceWorker')
    expect(page.headers.get('content-security-policy')).not.toContain(registerHash(''))
    expect(headers.get('content-security-policy')).not.toContain(registerHash(''))
    expect(settings).toBeUndefined()
    expect(text).toContain('self.registration.unregister()')
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

  // Runs the worker against a fake cache and network, visiting `path` once online and once offline, and returns what the offline visit got.
  async function visit(script: string, path: string, online: Map<string, Response>): Promise<{ status: number, body: string }> {
    const store = new Map<string, Response>()
    const listeners = new Map<string, (event: unknown) => void>()
    const cache = {
      put: async (key: Request | string, response: Response) => {
        store.set(new URL(typeof key === 'string' ? key : key.url, 'http://localhost').pathname, response)
      },
      match: async (key: Request | string) => store.get(new URL(typeof key === 'string' ? key : key.url, 'http://localhost').pathname)?.clone(),
      add: async (key: string) => {
        const response = online.get(key)

        if (!response)
          throw new Error('offline')

        store.set(key, response.clone())
      },
      addAll: async () => undefined,
    }
    let up = true
    const sandbox = {
      self: { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener), skipWaiting: async () => undefined, clients: { claim: async () => undefined }, registration: {} },
      caches: { open: async () => cache, keys: async () => [], delete: async () => true },
      location: { origin: 'http://localhost' },
      fetch: async (request: Request) => {
        const response = up ? online.get(new URL(request.url).pathname) : undefined

        if (!response)
          throw new Error('offline')

        return response.clone()
      },
      Response,
      URL,
    }
    // The worker is a plain script reading its globals, so it runs as a function taking them.
    // eslint-disable-next-line no-new-func
    const run = new Function(...Object.keys(sandbox), script) as (...globals: unknown[]) => void

    run(...Object.values(sandbox))

    const navigate = async () => {
      let reply: Promise<Response> | undefined

      listeners.get('fetch')!({ request: { method: 'GET', url: `http://localhost${path}`, mode: 'navigate', headers: new Headers() }, respondWith: (response: Promise<Response>) => {
        reply = response
      } })

      return reply
    }

    let waited: Promise<unknown> = Promise.resolve()

    listeners.get('install')!({ waitUntil: (promise: Promise<unknown>) => {
      waited = promise
    } })
    await waited
    up = false

    const reply = await navigate()

    return reply ? { status: (await reply).status, body: await (await reply).text() } : { status: 0, body: '' }
  }

  describe('keeps its pages whatever trailingSlash is', () => {
    it.each([
      ['always', '/about/', '/about/'],
      ['always', '/about/', '/about'],
      ['never', '/about', '/about'],
      ['ignore', '/about', '/about/'],
      ['ignore', '/about', '/about'],
    ] as const)('under %s, serving %s offline when %s is visited', async (trailingSlash, listed, visited) => {
      for (const offline of [true, { pages: ['/about'] }] satisfies (true | { pages: string[] })[]) {
        const dir = await mkdtemp(join(tmpdir(), 'kay-sw-'))

        try {
          const app = new Elysia()
          const client = { dir, pages: new Map([['/about', { pattern: '/about', file: 'about.html', status: 200, headers: {}, etag: '"a"', renderedAt: 0 }]]) } as unknown as ClientBuild

          await serveServiceWorker(app, new ServedPaths(), { client, offline, base: '', trailingSlash, publicPages: ['/about'] })

          const { settings, text } = await worker(app)
          const online = new Map([[listed, new Response('about page')]])

          expect(settings!.pages).toEqual([listed])
          expect(settings!.precache).toContain(listed)
          expect(await visit(text, visited, online)).toEqual({ status: 200, body: 'about page' })
        }
        finally {
          await rm(dir, { recursive: true, force: true })
        }
      }
    })

    it('serves a kept page opened from a search hit, whose link carries the words searched for', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'kay-sw-'))

      try {
        const app = new Elysia()
        const client = { dir, pages: new Map([['/about', { pattern: '/about', file: 'about.html', status: 200, headers: {}, etag: '"a"', renderedAt: 0 }]]) } as unknown as ClientBuild

        await serveServiceWorker(app, new ServedPaths(), { client, offline: true, base: '', trailingSlash: 'never', publicPages: ['/about'] })

        const { text } = await worker(app)
        const online = new Map([['/about', new Response('about page')]])

        expect(await visit(text, '/about?kay_q=about+page', online)).toEqual({ status: 200, body: 'about page' })
      }
      finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('under a base', async () => {
      const app = await pages({ routes: ROUTES, prebuilt: false, site: 'https://x.example', base: '/repo', trailingSlash: 'always', offline: { pages: ['/', '/about'] } })
      const { settings } = await worker(app)

      expect(settings!.pages).toEqual(['/repo/', '/repo/about/'])
    })
  })
})
