import type { Elysia } from 'elysia'
import type { OfflineConfig } from '../config'
import type { ClientBuild } from './client'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ASSET_PREFIX } from '../build/assets'
import { escapeAttribute } from '../runtime/escape'
import { PUBLIC_ENV_PATH } from './env'

export const SERVICE_WORKER = '/sw.js'
// Fetched before the page needs them: what the first offline visit cannot do without.
const PRECACHED = /\.(?:js|css|woff2?|ttf)$/
const SKIPPED = /\.(?:br|gz|map)$/
const BACKSLASH = /\\/g
// Bumped whenever the worker's own code changes, so every site installs it again.
const WORKER_VERSION = 2
// Past this many pages kept by default, the boot says to list the ones worth it.
const MANY_PAGES = 100

// The worker itself, plain JavaScript for every browser that has one: the build's files from the cache first, pages from the network first with the cached copy or the fallback offline, and kay's routes and the API always from the network.
const WORKER = `const FILES = new Set(KAY.files)
const PAGES = new Set(KAY.pages)

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(KAY.cache)
    const pages = new Set(KAY.pages)

    await cache.addAll(KAY.precache.filter(url => !pages.has(url)))

    // A page that fails, such as one a guard now covers, is left out rather than failing the install.
    for (const url of KAY.precache.filter(url => pages.has(url) || url === KAY.fallback)) {
      try {
        await cache.add(url)
      }
      catch {}
    }

    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('kay-') && name !== KAY.cache)
        await caches.delete(name)
    }

    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  // A range, as a video or an audio file asks for, goes to the network: the cache holds whole files only.
  if (request.method !== 'GET' || url.origin !== location.origin || request.headers.has('range'))
    return

  if (FILES.has(url.pathname))
    return event.respondWith(fromCache(request))

  if (url.pathname === KAY.env)
    return event.respondWith(fromNetwork(request, url.pathname))

  if (url.pathname === KAY.api || KAY.network.some(prefix => url.pathname.startsWith(prefix)))
    return

  if (request.mode === 'navigate' || request.headers.has('x-kay-navigate'))
    event.respondWith(page(request, url))
})

async function fromCache(request) {
  const cache = await caches.open(KAY.cache)
  const kept = await cache.match(request)

  if (kept)
    return kept

  const response = await fetch(request)

  if (whole(response))
    await cache.put(request, response.clone())

  return response
}

// A response kept as it is for anyone: a full 200 for the URL asked, not one a redirect led to, nor one for a single visitor.
function whole(response) {
  return response.status === 200 && !response.redirected && !/private|no-store/.test(response.headers.get('cache-control') || '')
}

async function fromNetwork(request, key) {
  const cache = await caches.open(KAY.cache)

  try {
    const response = await fetch(request)

    if (whole(response))
      await cache.put(key, response.clone())

    return response
  }
  catch (error) {
    const kept = await cache.match(key)

    if (kept)
      return kept

    throw error
  }
}

async function page(request, url) {
  try {
    return PAGES.has(url.pathname) && url.search === '' ? await fromNetwork(request, url.pathname) : await fetch(request)
  }
  catch (error) {
    const cache = await caches.open(KAY.cache)
    const fallback = KAY.fallback && await cache.match(KAY.fallback)

    if (fallback)
      return fallback

    if (request.mode === 'navigate')
      return new Response(KAY.offline, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } })

    throw error
  }
}
`

const UNREGISTER = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('kay-'))
        await caches.delete(name)
    }

    await self.registration.unregister()
  })())
})
`

export interface ServiceWorkerOptions {
  client: ClientBuild
  // Undefined serves a worker that removes itself: for `kay dev`, and a site that turned `offline` off.
  offline: true | OfflineConfig | undefined
  // The site's mount point: the worker is served under it, and controls only what is.
  base: string
  lang?: string
  // The prerendered pages of routes no guard covers, which every visitor gets alike, by path.
  publicPages: string[]
}

// What every page carries with `offline` on, registering the worker once the page has loaded.
export function registerScript(base: string): string {
  return `<script>if("serviceWorker"in navigator)addEventListener("load",function(){navigator.serviceWorker.register(${JSON.stringify(`${base}${SERVICE_WORKER}`)})})</script>`
}

// Serves the worker at `/sw.js` under the base, unless a public file or a page already does. Without `offline`, and in `kay dev`, the worker served removes itself, so one a production run or an earlier deploy left never serves a stale page.
export async function serveServiceWorker(app: Elysia, taken: ReadonlySet<string>, options: ServiceWorkerOptions): Promise<void> {
  if (taken.has(SERVICE_WORKER))
    return

  const script = options.offline ? await workerScript(options, options.offline) : UNREGISTER
  const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }

  app.get(SERVICE_WORKER, () => new Response(script, { headers }))
}

async function workerScript(options: ServiceWorkerOptions, offline: true | OfflineConfig): Promise<string> {
  const { base, client } = options
  const config = offline === true ? {} : offline
  const files = (await readdir(client.dir, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && !SKIPPED.test(entry.name))
    .map(entry => `${base}${ASSET_PREFIX}${join(entry.parentPath, entry.name).slice(client.dir.length + 1).replace(BACKSLASH, '/')}`)
    .sort()
  const pages = (config.pages ?? options.publicPages).map(path => `${base}${path}`).sort()

  // Each one is fetched on every deploy's install, by every visitor who has the worker.
  if (config.pages === undefined && pages.length > MANY_PAGES)
    console.warn(`[kay] offline keeps every prerendered page, ${pages.length} of them, which each visitor downloads on every deploy; list the ones worth reading offline in offline.pages`)

  const fallback = config.fallback === undefined ? undefined : `${base}${config.fallback}`
  // Changes with the build, its prerendered pages and the worker, so a deploy installs a new one, which drops the old cache.
  const version = Bun.hash(JSON.stringify([WORKER_VERSION, files, pages, fallback, [...client.pages].map(([path, page]) => [path, page.etag])])).toString(36)
  const settings = {
    cache: `kay-${version}`,
    precache: [...files.filter(file => PRECACHED.test(file)), ...pages, ...fallback === undefined ? [] : [fallback]],
    files,
    pages,
    fallback,
    env: `${base}${PUBLIC_ENV_PATH}`,
    network: [`${base}${ASSET_PREFIX}`, `${base}/api/`],
    api: `${base}/api`,
    offline: `<!doctype html><html lang="${escapeAttribute(options.lang ?? 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline</title></head><body><h1>Offline</h1><p>This page needs a connection, and none is open.</p></body></html>`,
  }

  return `const KAY = ${JSON.stringify(settings)}\n${WORKER}`
}
