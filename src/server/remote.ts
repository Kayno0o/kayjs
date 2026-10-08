import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

// One entry of `images.remote`: the origin, a `*.` subdomain wildcard allowed, and the path every URL starts with.
export interface RemotePattern {
  protocol: string
  host: string
  wildcard: boolean
  path: string
}

// A remote original kept on disk, or why the route answers without one.
export type RemoteOriginal = { path: string } | { status: number, message: string }

interface Stored {
  etag?: string
  lastModified?: string
  // Until when the original is served without asking the host again, in milliseconds.
  freshUntil: number
}

const PATTERN = /^(https?:)\/\/(\*\.)?([^/*?#@]+)(\/[^*?#]*)?$/i
const MAX_AGE = /(?:^|,)\s*max-age=(\d+)/i
const NO_CACHE = /(?:^|,)\s*(?:no-cache|no-store)\b/i

// Past this, a download is cut off: an image worth resizing is a few megabytes.
export const MAX_REMOTE_BYTES = 25 * 1024 * 1024
const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
// How long an original stays fresh when the host sends no `max-age`, and the bounds one it sends is held to.
const DEFAULT_FRESH_MS = 60 * 60_000
const MIN_FRESH_MS = 60_000
const MAX_FRESH_MS = 7 * 24 * 60 * 60_000
// A host that failed is not asked again before this, so a broken image cannot have the server fetch it on every request.
const RETRY_MS = 60_000

// `images.remote`, read once as the server boots, each entry refused with what is wrong with it.
export function remotePatterns(entries: readonly string[] = []): RemotePattern[] {
  return entries.map((entry) => {
    const match = PATTERN.exec(entry)

    if (!match)
      throw new Error(`images.remote holds ${entry}: an entry is an http or https origin, its host maybe starting with *. for any subdomain, and maybe a path: https://cms.example.com/uploads/`)

    return { protocol: match[1]!.toLowerCase(), host: match[3]!.toLowerCase(), wildcard: match[2] !== undefined, path: match[4] ?? '/' }
  })
}

// Whether `src` is an absolute URL some entry of `images.remote` covers.
export function remoteAllowed(src: string | URL, patterns: readonly RemotePattern[]): boolean {
  const url = typeof src === 'string' ? URL.parse(src) : src

  if (!url || url.username !== '' || url.password !== '')
    return false

  const host = url.host.toLowerCase()

  return patterns.some(pattern => url.protocol === pattern.protocol && (pattern.wildcard ? host.endsWith(`.${pattern.host}`) : host === pattern.host) && url.pathname.startsWith(pattern.path))
}

// Downloads an image another host serves, or keeps the copy `dir` holds while it is fresh, asking the host whether it changed once it is not. A host that fails leaves the last copy served, and is asked again a minute later.
export function remoteImages(dir: string, patterns: readonly RemotePattern[]): (src: string) => Promise<RemoteOriginal> {
  const stored = new Map<string, Stored>()
  const failedUntil = new Map<string, number>()
  const pending = new Map<string, Promise<RemoteOriginal>>()

  async function load(src: string, key: string): Promise<RemoteOriginal> {
    const path = join(dir, key)
    const meta = stored.get(key) ?? await readStored(`${path}.json`)
    const kept = meta !== undefined && await Bun.file(path).exists()

    if (kept && meta.freshUntil > Date.now())
      return { path }

    if ((failedUntil.get(key) ?? 0) > Date.now())
      return kept ? { path } : { status: 502, message: `Could not fetch ${src}` }

    const result = await download(src, path, kept ? meta : undefined)

    if ('status' in result) {
      failedUntil.set(key, Date.now() + RETRY_MS)

      return kept ? { path } : result
    }

    failedUntil.delete(key)
    stored.set(key, result)
    await Bun.write(`${path}.json`, JSON.stringify(result))

    return { path }
  }

  return async (src) => {
    if (!remoteAllowed(src, patterns))
      return { status: 403, message: `${src} is on a host images.remote in kay.config.ts does not list` }

    const key = Bun.hash(src).toString(36)
    let loading = pending.get(key)

    // Requests for an original being fetched wait for that one fetch.
    if (!loading) {
      loading = (async () => {
        try {
          return await load(src, key)
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

    if (previous?.etag)
      headers['if-none-match'] = previous.etag

    if (previous?.lastModified)
      headers['if-modified-since'] = previous.lastModified

    let response: Response
    let url = src

    try {
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)

      // Each hop is checked against the list, so a listed host cannot send the server to another.
      for (let hops = 0; ; hops++) {
        response = await fetch(url, { headers, signal, redirect: 'manual' })

        const location = response.headers.get('location')

        if (response.status < 300 || response.status >= 400 || response.status === 304 || location === null)
          break

        const next = URL.parse(location, url)

        await response.body?.cancel()

        if (!next || hops === MAX_REDIRECTS || !remoteAllowed(next, patterns))
          return { status: 502, message: `${src} redirects to ${location}, on a host images.remote does not list` }

        url = next.href
      }

      if (response.status === 304 && previous)
        return { ...previous, freshUntil: freshUntil(response.headers) }

      if (!response.ok) {
        await response.body?.cancel()

        return { status: 502, message: `${src} answered ${response.status}` }
      }

      if (Number(response.headers.get('content-length') ?? 0) > MAX_REMOTE_BYTES) {
        await response.body?.cancel()

        return { status: 413, message: `${src} is over ${MAX_REMOTE_BYTES} bytes` }
      }

      await mkdir(dir, { recursive: true })

      if (!await saveCapped(response, path))
        return { status: 413, message: `${src} is over ${MAX_REMOTE_BYTES} bytes` }
    }
    catch {
      return { status: 502, message: `Could not fetch ${src}` }
    }

    return { etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined, freshUntil: freshUntil(response.headers) }
  }
}

// Written under a temporary name and moved into place, so a reader never sees an original half downloaded; false once the body passed the cap.
async function saveCapped(response: Response, path: string): Promise<boolean> {
  const partial = `${path}.${crypto.randomUUID()}.tmp`
  const writer = Bun.file(partial).writer()
  let size = 0
  let saved = false

  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength

      if (size > MAX_REMOTE_BYTES)
        return false

      writer.write(chunk)
    }

    await writer.end()
    await rename(partial, path)
    saved = true

    return true
  }
  finally {
    if (!saved) {
      try {
        await writer.end()
      }
      catch {}

      await rm(partial, { force: true })
    }
  }
}

function freshUntil(headers: Headers): number {
  const control = headers.get('cache-control') ?? ''
  const maxAge = MAX_AGE.exec(control)
  const fresh = NO_CACHE.test(control) ? 0 : maxAge ? Number(maxAge[1]) * 1000 : DEFAULT_FRESH_MS

  return Date.now() + Math.min(MAX_FRESH_MS, Math.max(MIN_FRESH_MS, fresh))
}

async function readStored(path: string): Promise<Stored | undefined> {
  try {
    return await Bun.file(path).json() as Stored
  }
  catch {
    return undefined
  }
}
