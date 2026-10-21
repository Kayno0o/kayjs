import type { ClientBuild } from '../src/server/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { inlineScriptHashes } from '../src/server'
import { registerScript, serveServiceWorker } from '../src/server/offline'
import { ServedPaths } from '../src/server/served-paths'
import { pages } from './shared-pages'

const ROUTES = 'tests/fixtures/static/src/routes'
const SETTINGS = /^const KAY = (.+)$/m

interface WorkerSettings {
  cache: string
  versions: Record<string, string>
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

  it('keeps one cache across deploys and versions each URL, so an edit changes the version of what it touched alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-sw-'))
    const build = async (files: Record<string, string>, etags: Record<string, string>) => {
      for (const [file, text] of Object.entries(files))
        await Bun.write(join(dir, file), text)

      const app = new Elysia()
      const client = { dir, pages: new Map(Object.entries(etags).map(([path, etag]) => [path, { pattern: path, file: 'index.html', status: 200, headers: {}, etag, renderedAt: 0 }])) } as unknown as ClientBuild

      await serveServiceWorker(app, new ServedPaths(), { client, offline: true, base: '', publicPages: Object.keys(etags) })

      return (await worker(app)).settings!
    }

    try {
      const first = await build({ 'entry.js': 'a', 'app.css': 'a', 'assets/hero-a.png': 'a', 'entry.js.br': 'a' }, { '/': '"a"', '/about': '"a"' })

      expect(first.files).toEqual(['/_kay/app.css', '/_kay/assets/hero-a.png', '/_kay/entry.js'])
      expect(first.pages).toEqual(['/', '/about'])
      expect(Object.keys(first.versions)).toEqual(['/_kay/app.css', '/_kay/assets/hero-a.png', '/_kay/entry.js', '/', '/about'])

      const edited = await build({ 'entry.js': 'a' }, { '/': '"a"', '/about': '"b"' })

      expect(edited.cache).toBe(first.cache)
      expect(Object.keys(first.versions).filter(url => edited.versions[url] !== first.versions[url])).toEqual(['/about'])

      const script = await build({ 'entry.js': 'b' }, { '/': '"a"', '/about': '"b"' })

      expect(Object.keys(first.versions).filter(url => script.versions[url] !== first.versions[url])).toEqual(['/_kay/entry.js', '/about'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Installs the worker on a cache that outlives it, returning the URLs the install fetched.
  async function install(script: string, store: Map<string, string>): Promise<string[]> {
    const fetched: string[] = []
    const path = (key: Request | string) => decodeURI(new URL(typeof key === 'string' ? key : key.url, 'http://localhost').pathname)
    const cache = {
      match: async (key: string) => store.has(path(key)) ? new Response(store.get(path(key))) : undefined,
      put: async (key: string, response: Response) => void store.set(path(key), await response.text()),
      add: async (key: string) => {
        fetched.push(key)
        store.set(key, 'page')
      },
      addAll: async (keys: string[]) => {
        for (const key of keys)
          await cache.add(key)
      },
      keys: async () => [...store.keys()].map(key => ({ url: new URL(key, 'http://localhost').href })),
      delete: async (key: { url: string } | string) => store.delete(path(typeof key === 'string' ? key : key.url)),
    }
    const listeners = new Map<string, (event: unknown) => void>()
    const sandbox = { self: { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener), skipWaiting: async () => undefined }, caches: { open: async () => cache }, location: { origin: 'http://localhost' }, Response, URL }
    // eslint-disable-next-line no-new-func
    const run = new Function(...Object.keys(sandbox), script) as (...globals: unknown[]) => void

    run(...Object.values(sandbox))

    let waited: Promise<unknown> = Promise.resolve()

    listeners.get('install')!({ waitUntil: (promise: Promise<unknown>) => {
      waited = promise
    } })
    await waited

    return fetched
  }

  it('fetches again on an install only what changed since the last one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-sw-'))
    const store = new Map<string, string>()
    const build = async (script: string, etags: Record<string, string>) => {
      await Bun.write(join(dir, 'entry.js'), script)

      const app = new Elysia()
      const client = { dir, pages: new Map(Object.entries(etags).map(([path, etag]) => [path, { pattern: path, file: 'index.html', status: 200, headers: {}, etag, renderedAt: 0 }])) } as unknown as ClientBuild

      await serveServiceWorker(app, new ServedPaths(), { client, offline: true, base: '', publicPages: Object.keys(etags) })

      return (await worker(app)).text
    }

    try {
      expect((await install(await build('a', { '/': '"a"', '/about': '"a"' }), store)).toSorted()).toEqual(['/', '/_kay/entry.js', '/about'])
      expect(await install(await build('a', { '/': '"a"', '/about': '"a"' }), store)).toEqual([])
      expect(await install(await build('a', { '/': '"a"', '/about': '"b"' }), store)).toEqual(['/about'])
      expect(await install(await build('b', { '/': '"a"', '/about': '"b"' }), store)).toEqual(['/_kay/entry.js'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the copies of a path written with a space, and the old ones when an install fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-sw-'))
    const store = new Map<string, string>()
    const build = async (etag: string) => {
      await Bun.write(join(dir, 'assets/Open Sans-a.woff2'), 'a')

      const app = new Elysia()
      const client = { dir, pages: new Map([['/caf\u00E9', { pattern: '/caf\u00E9', file: 'index.html', status: 200, headers: {}, etag, renderedAt: 0 }]]) } as unknown as ClientBuild

      await serveServiceWorker(app, new ServedPaths(), { client, offline: true, base: '', publicPages: ['/caf\u00E9'] })

      return (await worker(app)).text
    }

    try {
      await install(await build('"a"'), store)
      expect(await install(await build('"a"'), store)).toEqual([])
      expect(await install(await build('"b"'), store)).toEqual(['/caf\u00E9'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps ahead only the font files whose characters the pages hold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-sw-'))
    const dir = join(root, 'dist')
    const rule = (name: string, range: string) => `@font-face{font-family:"F";src:url("/_kay/assets/${name}") format("woff2");unicode-range:${range}}`

    try {
      await Bun.write(join(dir, 'assets/f-latin-a.woff2'), 'a')
      await Bun.write(join(dir, 'assets/f-greek-a.woff2'), 'a')
      await Bun.write(join(dir, 'assets/f-cyrillic-a.woff2'), 'a')
      await Bun.write(join(root, 'pages/index.html'), '<p>caf\u00E9 \u03B1</p>')
      await Bun.write(join(root, 'fonts.json'), JSON.stringify({ css: rule('f-latin-a.woff2', 'U+0000-00FF,U+0131') + rule('f-greek-a.woff2', 'U+0370-03FF') + rule('f-cyrillic-a.woff2', 'U+04??'), preload: [] }))

      const app = new Elysia()
      const client = { dir, pages: new Map([['/', { pattern: '/', file: 'index.html', status: 200, headers: {}, etag: '"a"', renderedAt: 0 }]]) } as unknown as ClientBuild

      await serveServiceWorker(app, new ServedPaths(), { client, offline: true, base: '', publicPages: ['/'] })

      const { settings } = await worker(app)

      expect(settings!.precache).toEqual(['/_kay/assets/f-greek-a.woff2', '/_kay/assets/f-latin-a.woff2', '/'])
      expect(settings!.files).toContain('/_kay/assets/f-cyrillic-a.woff2')
    }
    finally {
      await rm(root, { recursive: true, force: true })
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
      keys: async () => [...store.keys()].map(path => ({ url: `http://localhost${path}` })),
      delete: async (key: { url: string }) => store.delete(new URL(key.url).pathname),
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
