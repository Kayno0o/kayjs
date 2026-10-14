import type { Elysia } from 'elysia'
import type { Claim, ServedPaths } from './served-paths'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import process from 'node:process'

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
  }).toSorted((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : 0)
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
// Files keep their names, so browsers revalidate them every time and get a 304 while they are unchanged.
// The body, or a 304 when the browser already holds the version the ETag names, carrying the same headers.
export function revalidated(request: Request, etag: string, body: () => BodyInit, headers: Record<string, string> = {}): Response {
  if (matchesEtag(request.headers.get('if-none-match'), etag))
    return new Response(null, { status: 304, headers: { ...headers, etag, 'cache-control': REVALIDATE } })

  return new Response(body(), { headers: { ...headers, etag, 'cache-control': REVALIDATE } })
}

// Registered once every path is claimed, so a path an HTML file was only offered and something claimed since is not served twice.
export async function servePublic(app: Elysia, served: ServedPaths, files: ClaimedFile[]): Promise<void> {
  for (const { path, url } of files.filter(file => served.holds(file.claim))) {
    const { size, mtimeMs } = await stat(path)
    const etag = `W/"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`

    app.get(url, ({ request }) => revalidated(request, etag, () => Bun.file(path)))
  }
}
