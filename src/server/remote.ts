import type { Resolver } from './address'
import type { RemoteLimits } from './config-limits'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { JSON_FILE, writeAtomically } from '../build/files'
import { isPublicAddress, pinnedLookup, PrivateAddressError, resolveHost } from './address'
import { FETCH_TIMEOUT_MS, MAX_REMOTE_BYTES } from './config-limits'
import { overLimit } from './protection'

export type { Resolver } from './address'

// One entry of `images.remote`: the origin, a `*.` subdomain wildcard allowed, and the path every URL starts with.
export interface RemotePattern {
  protocol: string
  host: string
  wildcard: boolean
  path: string
  // An entry naming one address (`http://10.0.0.5:9000`) or `localhost` is the app saying that host is its own, so it may be private; every other host must resolve to public addresses only.
  private: boolean
}

// A remote original kept on disk, with the key its variants are named after, or why the route answers without one.
export type RemoteOriginal = { path: string, key: string } | { status: number, message: string }

// Downloads the original `src` names, counting a download against `client` when given.
export type RemoteImages = (src: string, client?: string) => Promise<RemoteOriginal>

interface Stored {
  etag?: string | undefined
  lastModified?: string | undefined
  // Until when the original is served without asking the host again, in milliseconds.
  freshUntil: number
}

const PATTERN = /^(https?:)\/\/(\*\.)?([^/*?#@]+)(\/[^*?#]*)?$/i
const MAX_AGE = /(?:^|,)\s*max-age=(\d+)/i
const NO_CACHE = /(?:^|,)\s*(?:no-cache|no-store)\b/i

// Suffixes of more than one label under which anyone registers or deploys a subdomain, which a `*.` wildcard must not cover. A single label (`com`, `uk`) is refused already; this is the list of the common ones, not the whole Public Suffix List.
const PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'me.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.jp',
  'ne.jp',
  'or.jp',
  'co.kr',
  'co.in',
  'co.il',
  'co.za',
  'com.br',
  'com.cn',
  'com.mx',
  'com.ar',
  'com.tr',
  'com.sg',
  'com.hk',
  'com.tw',
  'github.io',
  'gitlab.io',
  'vercel.app',
  'now.sh',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'appspot.com',
  'herokuapp.com',
  'onrender.com',
  'fly.dev',
  'railway.app',
  'surge.sh',
  'ngrok.io',
  'ngrok-free.app',
  'glitch.me',
  'repl.co',
  'replit.app',
  'azurewebsites.net',
  'azurestaticapps.net',
  'cloudfront.net',
  'amazonaws.com',
  'elasticbeanstalk.com',
  'blogspot.com',
  'wordpress.com',
  'myshopify.com',
  'github.dev',
  'githubusercontent.com',
  'netlify.com',
  'ondigitalocean.app',
  'deno.dev',
  'pythonanywhere.com',
  'weebly.com',
  'wixsite.com',
  'carrd.co',
])

const BRACKETS = /^\[|\]$/g
const TRAILING_DOT = /\.$/

const MAX_REDIRECTS = 3
// How long an original stays fresh when the host sends no `max-age`, and the bounds one it sends is held to.
const DEFAULT_FRESH_MS = 60 * 60_000
const MIN_FRESH_MS = 60_000
const MAX_FRESH_MS = 7 * 24 * 60 * 60_000
// A host that failed is not asked again before this, so a broken image cannot have the server fetch it on every request.
const RETRY_MS = 60_000
// Any URL on a listed host may be asked for, a new query string each time, so the originals kept are capped, the least recently used going first with their variants, and so is how many new downloads one client starts a minute.
const MAX_ORIGINALS = 500
const DOWNLOADS_PER_MINUTE = 30
const MINUTE_MS = 60_000
const DOWNLOADS = 'kay:remote-images'

// `images.remote`, read once as the server boots, each entry refused with what is wrong with it.
export function remotePatterns(entries: readonly string[] = []): RemotePattern[] {
  return entries.map((entry) => {
    const match = PATTERN.exec(entry)

    if (!match)
      throw new Error(`images.remote holds ${entry}: an entry is an http or https origin, its host maybe starting with *. for any subdomain, and maybe a path: https://cms.example.com/uploads/`)

    // Read as a URL is, so a default port, a letter case or a host outside ASCII compares as the URLs asked for do.
    const wildcard = match[2] !== undefined
    const url = URL.parse(`${match[1]}//${wildcard ? 'x.' : ''}${match[3]}${match[4] ?? '/'}`)

    if (!url)
      throw new Error(`images.remote holds ${entry}, which is no URL`)

    // `*.com` would let any site of a whole top-level domain have the server download from it, and so would `*.co.uk` or `*.vercel.app`, whose subdomains belong to anyone.
    const base = url.hostname.slice(2).replace(TRAILING_DOT, '')

    if (wildcard && (!base.includes('.') || PUBLIC_SUFFIXES.has(base)))
      throw new Error(`images.remote holds ${entry}: a *. wildcard covers the subdomains of one domain, never a whole public suffix such as *.com, *.co.uk or *.vercel.app`)

    return { protocol: url.protocol, host: wildcard ? url.host.slice(2) : url.host, wildcard, path: url.pathname, private: !wildcard && (isIP(url.hostname.replace(BRACKETS, '')) !== 0 || url.hostname === 'localhost') }
  })
}

// Whether `src` is an absolute URL some entry of `images.remote` covers.
export function remoteAllowed(src: string | URL, patterns: readonly RemotePattern[]): boolean {
  const url = typeof src === 'string' ? URL.parse(src) : src

  if (!url || url.username !== '' || url.password !== '')
    return false

  return patterns.some(pattern => covers(pattern, url))
}

function covers(pattern: RemotePattern, url: URL): boolean {
  const host = url.host.toLowerCase()

  // A path without its final slash covers itself and what is below it, never `/uploads-private` for `/uploads`.
  return url.protocol === pattern.protocol && (pattern.wildcard ? host.endsWith(`.${pattern.host}`) : host === pattern.host) && (url.pathname === pattern.path || url.pathname.startsWith(pattern.path.endsWith('/') ? pattern.path : `${pattern.path}/`))
}

// How the image route's variants of a remote original start, so evicting it finds them.
export function remoteVariants(key: string): string {
  return `remote-${key}-`
}

// Downloads an image another host serves, or keeps the copy `dir` holds while it is fresh, asking the host whether it changed once it is not. A host that fails leaves the last copy served, and is asked again a minute later.
// `variantsDir` holds what the image route made of the originals, named after `remoteVariants`, removed with the original they came from.
export function remoteImages(dir: string, patterns: readonly RemotePattern[], variantsDir?: string, maxOriginals = MAX_ORIGINALS, limits: RemoteLimits = { bytes: MAX_REMOTE_BYTES, timeoutMs: FETCH_TIMEOUT_MS }, resolve: Resolver = resolveHost): RemoteImages {
  const stored = new Map<string, Stored>()
  const failedUntil = new Map<string, number>()
  const pending = new Map<string, Promise<RemoteOriginal>>()
  // Every key in use, least recently used first, read from the disk on first use so a restart keeps the cap.
  let used: Promise<Map<string, true>> | undefined

  async function load(src: string, key: string, client: string | undefined): Promise<RemoteOriginal> {
    const path = join(dir, key)
    const meta = stored.get(key) ?? await readStored(`${path}.json`)
    const kept = meta !== undefined && await Bun.file(path).exists()

    if (kept && meta.freshUntil > Date.now())
      return { path, key }

    if ((failedUntil.get(key) ?? 0) > Date.now())
      return kept ? { path, key } : { status: 502, message: 'The host did not give the image' }

    if (client !== undefined && overLimit(DOWNLOADS, client, DOWNLOADS_PER_MINUTE, MINUTE_MS) !== undefined)
      return kept ? { path, key } : { status: 429, message: 'Too many new images at once; try again in a minute' }

    const result = await download(src, path, kept ? meta : undefined)

    if ('status' in result) {
      // Each failing URL is remembered a minute, so what a flood of them leaves is dropped once it is past.
      if (failedUntil.size >= maxOriginals) {
        for (const [failed, until] of failedUntil) {
          if (until <= Date.now())
            failedUntil.delete(failed)
        }
      }

      failedUntil.set(key, Date.now() + RETRY_MS)

      return kept ? { path, key } : result
    }

    failedUntil.delete(key)
    stored.set(key, result)
    await Bun.write(`${path}.json`, JSON.stringify(result))

    return { path, key }
  }

  async function touch(key: string): Promise<void> {
    const keys = await (used ??= keptKeys(dir))

    keys.delete(key)
    keys.set(key, true)

    for (const [oldest] of keys) {
      if (keys.size <= maxOriginals)
        break

      keys.delete(oldest)
      stored.delete(oldest)
      failedUntil.delete(oldest)
      await evict(oldest)
    }
  }

  async function evict(key: string): Promise<void> {
    await Promise.all([rm(join(dir, key), { force: true }), rm(join(dir, `${key}.json`), { force: true })])

    if (variantsDir === undefined)
      return

    try {
      const prefix = remoteVariants(key)

      await Promise.all((await readdir(variantsDir)).filter(name => name.startsWith(prefix)).map(async name => rm(join(variantsDir, name), { force: true })))
    }
    catch {}
  }

  return async (src, client) => {
    if (!remoteAllowed(src, patterns))
      return { status: 403, message: 'The image is on a host images.remote in kay.config.ts does not list' }

    const key = Bun.hash(src).toString(36)
    let loading = pending.get(key)

    // Requests for an original being fetched wait for that one fetch.
    if (!loading) {
      loading = (async () => {
        try {
          const original = await load(src, key, client)

          if ('path' in original)
            await touch(key)

          return original
        }
        finally {
          pending.delete(key)
        }
      })()
      pending.set(key, loading)
    }

    return loading
  }

  async function download(src: string, path: string, previous: Stored | undefined): Promise<Stored | { status: number, message: string }> {
    const headers: Record<string, string> = {}

    if (previous?.etag !== undefined && previous.etag !== '')
      headers['if-none-match'] = previous.etag

    if (previous?.lastModified !== undefined && previous.lastModified !== '')
      headers['if-modified-since'] = previous.lastModified

    let response: Response
    let url = src

    try {
      const signal = AbortSignal.timeout(limits.timeoutMs)

      // Each hop is checked against the list and resolved to public addresses, so a listed host cannot send the server to another or to a private one.
      for (let hops = 0; ; hops++) {
        const target = new URL(url)

        response = await pinnedGet(target, headers, signal, resolve, patterns.some(pattern => pattern.private && covers(pattern, target)))

        const location = response.headers.get('location')

        if (response.status < 300 || response.status >= 400 || response.status === 304 || location === null)
          break

        const next = URL.parse(location, url)

        await response.body?.cancel()

        if (!next || hops === MAX_REDIRECTS || !remoteAllowed(next, patterns))
          return { status: 502, message: 'The host redirects to one images.remote does not list' }

        url = next.href
      }

      const encoding = response.headers.get('content-encoding')

      if (encoding !== null && encoding !== 'identity') {
        await response.body?.cancel()

        return { status: 502, message: 'The host sent the image compressed' }
      }

      if (response.status === 304 && previous)
        return { ...previous, freshUntil: freshUntil(response.headers) }

      if (!response.ok) {
        await response.body?.cancel()

        return { status: 502, message: `The host answered ${response.status}` }
      }

      if (Number(response.headers.get('content-length') ?? 0) > limits.bytes) {
        await response.body?.cancel()

        return { status: 413, message: `The image is over ${limits.bytes} bytes` }
      }

      await mkdir(dir, { recursive: true })

      if (!await saveCapped(response, path, limits.bytes))
        return { status: 413, message: `The image is over ${limits.bytes} bytes` }
    }
    catch (error) {
      if (error instanceof PrivateAddressError)
        return { status: 502, message: 'The host is at an address that is not public' }

      return { status: 502, message: 'The host did not give the image' }
    }

    return { etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined, freshUntil: freshUntil(response.headers) }
  }
}

// One GET that resolves the host itself and connects to the address it checked, never one `fetch` would resolve again after the check. A literal address is checked as it stands.
async function pinnedGet(url: URL, headers: Record<string, string>, signal: AbortSignal, resolve: Resolver, allowPrivate: boolean): Promise<Response> {
  const hostname = url.hostname.replace(BRACKETS, '')

  if (!allowPrivate && isIP(hostname) !== 0 && !isPublicAddress(hostname))
    throw new PrivateAddressError(`${hostname} is not a public address`)

  const send = url.protocol === 'https:' ? httpsRequest : httpRequest

  return new Promise((done, fail) => {
    const request = send(url, { method: 'GET', headers: { 'user-agent': 'kay', 'accept': 'image/*', ...headers, 'accept-encoding': 'identity' }, signal, lookup: pinnedLookup(resolve, allowPrivate) as never }, (incoming) => {
      try {
        const answer = new Headers()

        for (const [name, value] of Object.entries(incoming.headers)) {
          for (const each of Array.isArray(value) ? value : [value]) {
            if (each !== undefined)
              answer.append(name, each)
          }
        }

        const status = incoming.statusCode ?? 502
        const empty = status === 204 || status === 205 || status === 304

        if (empty)
          incoming.resume()

        done(new Response(empty ? null : Readable.toWeb(incoming) as unknown as ReadableStream, { status, headers: answer }))
      }
      catch (error) {
        // A status `Response` refuses, such as 999, would otherwise throw inside the event and leave the promise pending.
        incoming.destroy()
        fail(error)
      }
    })

    request.on('error', fail)
    request.end()
  })
}

// False once the body passed the cap, leaving no file behind.
async function saveCapped(response: Response, path: string, cap: number): Promise<boolean> {
  return writeAtomically(path, async (partial) => {
    const writer = Bun.file(partial).writer()
    let size = 0
    let ended = false

    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength

        if (size > cap)
          return false

        void writer.write(chunk)
      }

      ended = true
      await writer.end()

      return true
    }
    finally {
      if (!ended) {
        try {
          await writer.end()
        }
        catch {}
      }
    }
  })
}

function freshUntil(headers: Headers): number {
  const control = headers.get('cache-control') ?? ''
  const maxAge = MAX_AGE.exec(control)
  let fresh = DEFAULT_FRESH_MS

  if (NO_CACHE.test(control))
    fresh = 0
  else if (maxAge)
    fresh = Number(maxAge[1]) * 1000

  return Date.now() + Math.min(MAX_FRESH_MS, Math.max(MIN_FRESH_MS, fresh))
}

// The originals a directory holds, least recently written first.
async function keptKeys(dir: string): Promise<Map<string, true>> {
  try {
    const names = (await readdir(dir)).filter(name => JSON_FILE.test(name))
    const times = await Promise.all(names.map(async name => ({ key: name.slice(0, -5), time: (await stat(join(dir, name))).mtimeMs })))

    return new Map(times.toSorted((a, b) => a.time - b.time).map(({ key }) => [key, true]))
  }
  catch {
    return new Map()
  }
}

async function readStored(path: string): Promise<Stored | undefined> {
  try {
    return await Bun.file(path).json() as Stored
  }
  catch {
    return undefined
  }
}
