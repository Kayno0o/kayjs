import type { Elysia } from 'elysia'
import type { OfflineConfig, TrailingSlash } from '../config'
import type { ClientBuild } from './client'
import type { I18n } from './i18n'
import type { ServedPaths } from './served-paths'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ASSET_PREFIX, ASSETS_DIR } from '../build/assets'
import { NOTICES_FILE } from '../build/licenses'
import { escape, escapeAttribute } from '../runtime/escape'
import { textDirection } from '../runtime/i18n'
import { runInLocale } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { PRERENDERED_DIR } from './client'
import { fixedReply } from './compress'
import { PUBLIC_ENV_PATH } from './env-state'
import { builtFonts } from './fonts'
import { DEFAULT_LANG, stateFor } from './i18n'
import { slashedPath } from './routes'
import { kayWord } from './words'

export const SERVICE_WORKER = '/sw.js'
// Fetched before the page needs them: what the first offline visit cannot do without.
const PRECACHED = /\.(?:js|css|woff2?|ttf)$/
const SKIPPED = /\.(?:br|gz|map)$/
const BACKSLASH = /\\/g
// A rule of the fonts' stylesheet naming its file and the range of characters it holds.
const FACE_RANGE = /url\("([^"]+)"\)[^}]*?unicode-range:([^;}]+)/g
// Bumped whenever the worker's own code changes, so every site installs it again.
const WORKER_VERSION = 5
// Past this many pages kept by default, the boot says to list the ones worth it.
const MANY_PAGES = 100

// The worker itself, plain JavaScript for every browser that has one: the build's files from the cache first, pages from the network first with the cached copy or the fallback offline, and kay's routes and the API always from the network.
const WORKER = `const FILES = new Set(KAY.files)
// A page by its path without a trailing slash, to the URL it is kept under: a visit to /menu/ finds the copy of /menu whatever trailingSlash writes.
const PAGES = new Map(KAY.pages.map(url => [bare(url), url]))

function bare(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(KAY.cache)
    const pages = new Set(KAY.pages)
    let before = {}

    try {
      before = await (await cache.match(KAY.index)).json()
    }
    catch {}

    // A copy stays while its version is the one recorded, and one that changed is replaced by its download, so a failed install leaves the old copies; keys are decoded, as the URLs listed are written raw.
    const have = new Set()

    for (const request of await cache.keys()) {
      const path = decodeURI(new URL(request.url).pathname)

      if (path === KAY.env || path === KAY.index)
        continue

      if (KAY.versions[path] === undefined)
        await cache.delete(request)
      else if ((before[path] || '') === KAY.versions[path])
        have.add(path)
      else if (!KAY.precache.includes(path))
        await cache.delete(request)
    }

    const missing = KAY.precache.filter(url => !have.has(url))

    await cache.addAll(missing.filter(url => !pages.has(url) && url !== KAY.fallback))

    // A page that fails, such as one a guard now covers, is left out rather than failing the install, and its old copy goes.
    for (const url of missing.filter(url => pages.has(url) || url === KAY.fallback)) {
      try {
        await cache.add(url)
      }
      catch {
        await cache.delete(url)
      }
    }

    await cache.put(KAY.index, new Response(JSON.stringify(KAY.versions)))
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

// A page opened from a search hit carries the words searched for, which change nothing it serves.
async function page(request, url) {
  try {
    const kept = PAGES.get(bare(url.pathname))

    return kept !== undefined && [...url.searchParams.keys()].every(name => name === 'kay_q') ? await fromNetwork(request, kept) : await fetch(request)
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
  // How the site writes a page's path, which the pages are kept under.
  trailingSlash?: TrailingSlash | undefined
  lang?: string | undefined
  // The site's locales, whose default one words the page a visitor offline gets in place of one that was not kept.
  locales?: I18n | undefined
  // The prerendered pages of routes no guard covers, which every visitor gets alike, by path.
  publicPages: string[]
}

const registerScripts = new Map<string, string>()

// What every page carries with `offline` on, registering the worker once the page has loaded.
export function registerScript(base: string): string {
  let script = registerScripts.get(base)

  if (script === undefined)
    registerScripts.set(base, script = `<script>if("serviceWorker"in navigator)addEventListener("load",function(){navigator.serviceWorker.register(${JSON.stringify(`${base}${SERVICE_WORKER}`)})})</script>`)

  return script
}

// Serves the worker at `/sw.js` under the base, unless the app already serves that path. Without `offline`, and in `kay dev`, the worker served removes itself, so one a production run or an earlier deploy left never serves a stale page.
export async function serveServiceWorker(app: Elysia, served: ServedPaths, options: ServiceWorkerOptions): Promise<void> {
  if (!served.offer({ path: SERVICE_WORKER, owner: 'the service worker', kind: 'kay', exported: true }))
    return

  const script = options.offline !== undefined ? await workerScript(options, options.offline) : UNREGISTER
  const reply = fixedReply(script, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })

  app.get(SERVICE_WORKER, async ({ request }) => reply(request))
}

// A font file of a face with several subsets is kept ahead only when a character of the pages kept falls in its `unicode-range`; the others are kept as a visit loads them.
async function unusedSubsets(client: ClientBuild, pages: (string | undefined)[]): Promise<Set<string>> {
  const css = (await builtFonts(join(client.dir, '..')))?.css
  const unused = new Set<string>()

  if (css === undefined)
    return unused

  const dir = join(client.dir, '..', PRERENDERED_DIR)
  const characters = new Set<number>()

  try {
    for (const file of new Set(pages)) {
      if (file !== undefined) {
        for (const character of await Bun.file(join(dir, file)).text())
          characters.add(character.codePointAt(0)!)
      }
    }
  }
  catch {
    return unused
  }

  // Without any text read, such as pages the server renders, nothing says which subsets are unused.
  if (characters.size === 0)
    return unused

  const codes = [...characters]

  for (const [, url, ranges] of css.matchAll(FACE_RANGE)) {
    const spans = ranges!.split(',').map((range) => {
      const [low, high = low] = range.trim().slice(2).split('-')

      return [Number.parseInt(low!.replaceAll('?', '0'), 16), Number.parseInt(high!.replaceAll('?', 'F'), 16)] as const
    })

    if (!codes.some(code => spans.some(([from, to]) => code >= from && code <= to)))
      unused.add(decodeURIComponent(url!))
  }

  return unused
}

async function workerScript(options: ServiceWorkerOptions, offline: true | OfflineConfig): Promise<string> {
  const { base, client } = options
  const config = offline === true ? {} : offline
  const found = (await readdir(client.dir, { recursive: true, withFileTypes: true }))
    // The notices file is read once in a while, online, and never worth a copy on every visitor's device.
    .filter(entry => entry.isFile() && !SKIPPED.test(entry.name) && entry.name !== NOTICES_FILE)
    .map((entry) => {
      const relative = join(entry.parentPath, entry.name).slice(client.dir.length + 1).replace(BACKSLASH, '/')

      return { url: `${base}${ASSET_PREFIX}${relative}`, path: join(entry.parentPath, entry.name), named: relative.startsWith(`${ASSETS_DIR}/`) }
    })
    .toSorted((a, b) => a.url < b.url ? -1 : 1)
  const files = found.map(file => file.url)
  const listed = (config.pages ?? options.publicPages).map(path => ({ path, url: slashedPath(`${base}${path}`, options.trailingSlash) })).toSorted((a, b) => a.url < b.url ? -1 : 1)
  const pages = listed.map(page => page.url)
  const rendered = config.pages?.filter(path => client.pages.get(path)?.islands !== undefined) ?? []

  // Pages with server islands are not kept offline by default: an island needs the server, and an offline copy would keep one visitor's render.
  if (rendered.length > 0)
    kayLog('warn', `offline.pages lists ${rendered.join(', ')}, whose server islands render per request: offline, a visitor gets the copy cached when the worker installed`)

  if (config.pages === undefined && pages.length > MANY_PAGES)
    kayLog('warn', `offline keeps every prerendered page, ${pages.length} of them, which each visitor downloads on their first visit; list the ones worth reading offline in offline.pages`)

  const fallback = config.fallback === undefined ? undefined : slashedPath(`${base}${config.fallback}`, options.trailingSlash)
  // A page the build holds no copy of, such as a fallback the routes render, is fetched again whenever any page changed.
  const anyPage = Bun.hash(JSON.stringify([...client.pages].map(([path, page]) => [path, page.etag]))).toString(36)
  const pageVersion = (path: string) => client.pages.get(path)?.etag ?? anyPage
  // A file the build names after its content keeps its URL as its version; the others, a script or a stylesheet, are hashed.
  const versions: Record<string, string> = Object.fromEntries(await Promise.all(found.map(async file => [file.url, file.named ? '' : Bun.hash(await Bun.file(file.path).bytes()).toString(36)])))

  for (const page of listed)
    versions[page.url] = pageVersion(page.path)

  if (fallback !== undefined)
    versions[fallback] = pageVersion(config.fallback!)

  const skipped = await unusedSubsets(client, [...listed.map(page => client.pages.get(page.path)?.file), ...config.fallback === undefined ? [] : [client.pages.get(config.fallback)?.file]])
  const settings = {
    // Kept across deploys: a copy is fetched again only when its version in `versions` changed, and the worker's own code changes the name.
    cache: `kay-w${WORKER_VERSION}`,
    index: `${base}${ASSET_PREFIX}sw-versions`,
    versions,
    precache: [...files.filter(file => PRECACHED.test(file) && !skipped.has(file.slice(base.length))), ...pages, ...fallback === undefined ? [] : [fallback]],
    files,
    pages,
    fallback,
    env: `${base}${PUBLIC_ENV_PATH}`,
    network: [`${base}${ASSET_PREFIX}`, `${base}/api/`],
    api: `${base}/api`,
    offline: offlinePage(options),
  }

  return `const KAY = ${JSON.stringify(settings)}\n${WORKER}`
}

// The page a visitor offline gets for one that was not kept, in the site's default locale: the worker is one script for every visitor, so it cannot follow theirs.
function offlinePage(options: ServiceWorkerOptions): string {
  const lang = options.locales?.settings.defaultLocale ?? options.lang ?? DEFAULT_LANG
  const words = () => ({ title: escape(kayWord('kay.offline.title')), text: escape(kayWord('kay.offline.text')) })
  const { title, text } = options.locales === undefined ? words() : runInLocale(stateFor(options.locales, lang, '/', new Request('http://localhost/')), words)

  return `<!doctype html><html lang="${escapeAttribute(lang)}"${textDirection(lang) === 'rtl' ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><h1>${title}</h1><p>${text}</p></body></html>`
}
