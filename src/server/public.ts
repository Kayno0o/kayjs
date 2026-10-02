import type { Elysia } from 'elysia'
import type { Route } from './routes'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import process from 'node:process'

const CACHE_CONTROL = 'public, max-age=0, must-revalidate'
const WILDCARD = /\*/g

// One route per file found at boot: no file system lookup per request, and no path a request could steer outside the directory.
// Files keep their names, so browsers revalidate them every time and get a 304 while they are unchanged.
export async function servePublic(app: Elysia, dir: string, routes: Route[]): Promise<void> {
  if (!existsSync(dir))
    return

  const pages = new Set(routes.map(route => route.pattern))

  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile())
      continue

    const path = join(entry.parentPath, entry.name)
    // Encoded the way a browser sends it, a `:` or `*` in a name never reads as a route parameter.
    const url = `/${relative(dir, path).split(sep).map(segment => encodeURIComponent(segment).replace(WILDCARD, '%2A')).join('/')}`

    if (pages.has(url))
      throw new Error(`kay: ${relative(process.cwd(), path)} and a page both serve ${url}`)

    const { size, mtimeMs } = await stat(path)
    const etag = `W/"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`

    app.get(url, ({ request }) => request.headers.get('if-none-match') === etag
      ? new Response(null, { status: 304, headers: { etag, 'cache-control': CACHE_CONTROL } })
      : new Response(Bun.file(path), { headers: { etag, 'cache-control': CACHE_CONTROL } }))
  }
}
