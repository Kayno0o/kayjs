import type { Elysia } from 'elysia'
import type { Duration } from '../runtime/duration'
import type { Claim, ServedPaths } from './served-paths'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import process from 'node:process'
import { wholeSeconds } from '../runtime/duration'
import { COMPRESSIBLE_TYPE, readResponse } from './compress'

// For a file served under a name that stays when its content changes.
export const REVALIDATE = 'public, max-age=0, must-revalidate'
// What `encodeURIComponent` escapes but a browser sends as is in a path; `:` stays escaped, since Elysia would read it as a parameter.
const SENT_AS_IS = /%(?:40|2B|2C|3B|3D|26|24|5B|5D|7C)/g
// What `encodeURIComponent` keeps but Elysia reads as a wildcard or breaks the code it generates on.
const ROUTER_SYNTAX = /['*]/g
const WEAK_PREFIX = /^W\//
const HTML = '.html'
// What an editor, a deploy or a secret leaves in `public/` rather than what a visitor is meant to fetch, a file or a directory: `.env` files and backups.
const LEFT_BEHIND = /\.env(?:\..*)?$|\.(?:bak|old|orig|swp|tmp)$|~$/i
// The dotfiles a static host reads rather than serves, which a static export keeps.
const HOST_FILES = new Set(['.htaccess', '.nojekyll'])
const INDEX = '/index.html'
const LEADING_SLASH = /^\//
// The kinds of public file that rarely change, kept without asking again unless `publicCache` says otherwise: a font for 30 days, an image for a day, so one replaced in place shows within a day of the deploy.
const FONT = /\.(?:woff2?|ttf|otf|eot)$/i
const IMAGE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i
const FONT_CONTROL = `public, max-age=${30 * 86_400}`
const IMAGE_CONTROL = 'public, max-age=86400'
// The text files kept in memory so compressing one reads nothing again: none above the first, and no more than the second altogether.
const KEPT_FILE_BYTES = 256 * 1024
const KEPT_TOTAL_BYTES = 8 * 1024 * 1024

export interface PublicFile {
  path: string
  url: string
}

export interface ClaimedFile extends PublicFile {
  claim: Claim
}

// Every file under the directory with the URL path it is served at, written the way a browser sends it: `/logo@2x.png`, `/c%3Ad.txt`.
export async function publicFiles(dir: string): Promise<PublicFile[]> {
  if (!existsSync(dir))
    return []

  const entries = await readdir(dir, { recursive: true, withFileTypes: true })

  // By URL, as the directory's own order changes from one file system to the next.
  return entries.filter(entry => entry.isFile() && servedPublicly(relative(dir, join(entry.parentPath, entry.name)))).map((entry) => {
    const path = join(entry.parentPath, entry.name)

    return { path, url: `/${relative(dir, path).split(sep).map(urlSegment).join('/')}` }
  }).toSorted((a, b) => {
    if (a.url === b.url)
      return 0

    return a.url < b.url ? -1 : 1
  })
}

// Whether a file of `public/`, by its path from it, goes out: never one left behind there, nor under a dot-directory or as a dotfile but `.well-known/` and, exported, the static host's own.
export function servedPublicly(path: string, exported = false): boolean {
  return path.split(sep).every(segment => !LEFT_BEHIND.test(segment) && (!segment.startsWith('.') || segment === '.well-known' || (exported && HOST_FILES.has(segment))))
}

function urlSegment(name: string): string {
  return encodeURIComponent(name).replace(SENT_AS_IS, decodeURIComponent).replace(ROUTER_SYNTAX, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

// Each file takes its path, which a page serving it already refuses; the paths an HTML file is also served at give way to anything else, claimed before or after.
// Every file is claimed before the clashes throw, all of them together, so `kay check` reports each one.
export function claimPublic(served: ServedPaths, files: PublicFile[]): ClaimedFile[] {
  const clashes: Error[] = []
  const claimed = files.flatMap((file) => {
    const owner = relative(process.cwd(), file.path)
    const claim = { path: file.url, owner, kind: 'public' as const }

    try {
      served.claim(claim, taken => taken.kind === 'page' ? `kay: ${owner} and a page both serve ${file.url}` : `kay: ${taken.owner} and ${owner} both serve ${file.url}`)
    }
    catch (error) {
      clashes.push(error as Error)

      return []
    }

    return [{ ...file, claim }]
  })

  const [clash, ...more] = clashes

  if (clash && more.length === 0)
    throw clash

  if (clash)
    throw new AggregateError(clashes, clashes.map(each => each.message).join('\n'))

  const fallbacks = htmlFallbacks(files, new Set()).map(file => ({ ...file, claim: { path: file.url, owner: relative(process.cwd(), file.path), kind: 'public' as const } }))

  return [...claimed, ...fallbacks.filter(file => served.offer(file.claim))]
}

// The paths a static host's `try_files $uri $uri.html $uri/index.html` serves an HTML file at besides its own: `/x` for `x.html`, else for `x/index.html`, so a site exported under the directory keeps its links without `.html`.
// What a file or a page already serves stays theirs.
export function htmlFallbacks(files: PublicFile[], pages: Set<string>): PublicFile[] {
  const taken = new Set([...pages, ...files.map(file => file.url)])
  const html = files.filter(file => file.url.endsWith(HTML) && !file.url.endsWith(`/${HTML}`))
  const fallbacks = new Map(html.map(file => [file.url.slice(0, -HTML.length), file.path]))

  for (const { path, url } of html) {
    const dir = url.endsWith(INDEX) ? url.slice(0, -INDEX.length) || '/' : undefined

    if (dir !== undefined && !fallbacks.has(dir))
      fallbacks.set(dir, path)
  }

  return [...fallbacks].filter(([url]) => !taken.has(url)).map(([url, path]) => ({ path, url }))
}

// Caches and proxies may send several tags, a weak one or `*`; a revalidation compares them weakly.
export function matchesEtag(header: string | null, etag: string): boolean {
  const tag = etag.replace(WEAK_PREFIX, '')

  return header !== null && header.split(',').some(item => item.trim() === '*' || item.trim().replace(WEAK_PREFIX, '') === tag)
}

// One route per file found at boot: no file system lookup per request, and no path a request could steer outside the directory.
// Files keep their names, so unless `cache` keeps it, a file is revalidated every time and answered with a 304 while it is unchanged.
// The body, or a 304 when the browser already holds the version the ETag names, carrying the same headers.
// `cache` replaces the header for a file that may be kept for a while before it is asked about again.
export function revalidated(request: Request, etag: string, body: () => BodyInit, headers: Record<string, string> = {}, cache = REVALIDATE): Response {
  if (matchesEtag(request.headers.get('if-none-match'), etag))
    return new Response(null, { status: 304, headers: { ...headers, etag, 'cache-control': cache } })

  return new Response(body(), { headers: { ...headers, etag, 'cache-control': cache } })
}

// The `cache-control` of each public file the `publicCache` setting names, the first pattern a path matches deciding; a file it leaves out is kept by its kind, a font or an image, and else revalidates, as a manifest, `robots.txt`, a script or a page must.
export function publicCacheRules(setting: Record<string, Duration> | undefined): ((url: string) => string) {
  // A zero keeps the files a glob names revalidating, for an app replacing a font or an image in place.
  const rules = Object.entries(setting ?? {}).map(([pattern, value]) => ({ glob: new Bun.Glob(pattern.replace(LEADING_SLASH, '')), control: value === 0 ? REVALIDATE : `public, max-age=${wholeSeconds(value, `publicCache['${pattern}']`)}` }))

  return url => rules.find(rule => rule.glob.match(url.replace(LEADING_SLASH, '')))?.control ?? defaultControl(url)
}

function defaultControl(url: string): string {
  if (FONT.test(url))
    return FONT_CONTROL

  return IMAGE.test(url) ? IMAGE_CONTROL : REVALIDATE
}

// The bytes of a file as they stand, read again only when its size or date changed; undefined for a file too large to keep, or one that would pass the total.
// What `held` counts is shared by every file of the server, which pass it in.
function keeper(path: string, held: { bytes: number }): () => Uint8Array<ArrayBuffer> | undefined {
  let kept: { size: number, mtimeMs: number, bytes: Uint8Array<ArrayBuffer> } | undefined

  return () => {
    const stat = statSync(path, { throwIfNoEntry: false })

    if (!stat?.isFile())
      return undefined

    if (kept?.size === stat.size && kept.mtimeMs === stat.mtimeMs)
      return kept.bytes

    held.bytes -= kept?.bytes.length ?? 0
    kept = undefined

    if (stat.size > KEPT_FILE_BYTES || held.bytes + stat.size > KEPT_TOTAL_BYTES)
      return undefined

    const bytes = new Uint8Array(readFileSync(path))

    kept = { size: stat.size, mtimeMs: stat.mtimeMs, bytes }
    held.bytes += bytes.length

    return bytes
  }
}

// Registered once every path is claimed, so a path an HTML file was only offered and something claimed since is not served twice.
// With `compressing`, a text file small enough is answered from its bytes kept in memory, which compression takes as they are; a range request, which Bun answers from the file, and the rest stream the file.
export async function servePublic(app: Elysia, served: ServedPaths, files: ClaimedFile[], cacheFor: (url: string) => string = () => REVALIDATE, compressing = false): Promise<void> {
  const held = { bytes: 0 }

  for (const { path, url } of files.filter(file => served.holds(file.claim))) {
    const { size, mtimeMs } = await stat(path)
    const etag = `W/"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`

    const cache = cacheFor(url)
    const { type } = Bun.file(path)
    const read = compressing && COMPRESSIBLE_TYPE.test(type) ? keeper(path, held) : undefined

    app.get(url, ({ request }) => {
      const bytes = request.headers.has('range') ? undefined : read?.()

      if (!bytes)
        return revalidated(request, etag, () => Bun.file(path), {}, cache)

      const response = revalidated(request, etag, () => bytes, { 'content-type': type }, cache)

      return response.status === 200 ? readResponse(response, bytes) : response
    })
  }
}
