import type { Elysia } from 'elysia'
import type { Route } from './routes'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import process from 'node:process'
import { servedPaths } from './routes'

// For a file served under a name that stays when its content changes.
export const REVALIDATE = 'public, max-age=0, must-revalidate'
// What `encodeURIComponent` escapes but a browser sends as is in a path; `:` stays escaped, since Elysia would read it as a parameter.
const SENT_AS_IS = /%(?:40|2B|2C|3B|3D|26|24|5B|5D|7C)/g
// What `encodeURIComponent` keeps but Elysia reads as a wildcard or breaks the code it generates on.
const ROUTER_SYNTAX = /['*]/g
const WEAK_PREFIX = /^W\//

// Every file under the directory with the URL path it is served at, written the way a browser sends it: `/logo@2x.png`, `/c%3Ad.txt`.
export async function publicFiles(dir: string): Promise<{ path: string, url: string }[]> {
  if (!existsSync(dir))
    return []

  const entries = await readdir(dir, { recursive: true, withFileTypes: true })

  return entries.filter(entry => entry.isFile()).map((entry) => {
    const path = join(entry.parentPath, entry.name)

    return { path, url: `/${relative(dir, path).split(sep).map(urlSegment).join('/')}` }
  })
}

function urlSegment(name: string): string {
  return encodeURIComponent(name).replace(SENT_AS_IS, decodeURIComponent).replace(ROUTER_SYNTAX, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

// Caches and proxies may send several tags, a weak one or `*`; a revalidation compares them weakly.
export function matchesEtag(header: string | null, etag: string): boolean {
  const tag = etag.replace(WEAK_PREFIX, '')

  return header !== null && header.split(',').some(item => item.trim() === '*' || item.trim().replace(WEAK_PREFIX, '') === tag)
}

// One route per file found at boot: no file system lookup per request, and no path a request could steer outside the directory.
// Files keep their names, so browsers revalidate them every time and get a 304 while they are unchanged.
// The body, or a 304 when the browser already holds the version the ETag names.
export function revalidated(request: Request, etag: string, body: () => BodyInit, headers: Record<string, string> = {}): Response {
  if (matchesEtag(request.headers.get('if-none-match'), etag))
    return new Response(null, { status: 304, headers: { etag, 'cache-control': REVALIDATE } })

  return new Response(body(), { headers: { ...headers, etag, 'cache-control': REVALIDATE } })
}

export async function servePublic(app: Elysia, dir: string, routes: Route[]): Promise<Set<string>> {
  const pages = servedPaths(routes)
  const files = await publicFiles(dir)

  for (const { path, url } of files) {
    if (pages.has(url))
      throw new Error(`kay: ${relative(process.cwd(), path)} and a page both serve ${url}`)

    const { size, mtimeMs } = await stat(path)
    const etag = `W/"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`

    app.get(url, ({ request }) => revalidated(request, etag, () => Bun.file(path)))
  }

  return new Set(files.map(file => file.url))
}
