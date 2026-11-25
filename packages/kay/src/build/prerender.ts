// Build-time rendering: routes exporting `prerender = true` (and every route in a static export) are rendered through the real server and written as HTML.

import type { KayPlugin } from '../plugins/index'
import type { RouteManifestEntry } from './manifest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { relPosix } from './files'
import { assertPathUrls } from './routes'

const CONCURRENCY = 8
const SLASH_EDGES_RE = /^\/|\/$/g

let prerenderImportSeq = 0

function resolvePrerenderHtmlPath(prerenderDir: string, urlStr: string, isStatic: boolean): string {
  const pathname = new URL(urlStr, 'http://localhost').pathname
  const rel = pathname === '/'
    ? 'index.html'
    : (isStatic && pathname === '/404')
        ? '404.html'
        : `${pathname.replace(SLASH_EDGES_RE, '')}/index.html`
  const absRoot = resolve(prerenderDir)
  const abs = resolve(absRoot, rel)
  if (!abs.startsWith(`${absRoot}/`) && !abs.startsWith(`${absRoot}\\`))
    throw new Error(`kay build: prerender path "${urlStr}" escapes output directory.`)
  return abs
}

export interface PrerenderOptions {
  root: string
  outDir: string
  assetPrefix: string
  plugins: KayPlugin[]
  isDev: boolean
  isStatic: boolean
  /** Where the HTML lands: the static stage dir, or `<outDir>/prerendered`. */
  prerenderDir: string
  routes: RouteManifestEntry[]
}

/** Renders every route to HTML, records `route.prerendered`, and returns the server the pages were rendered with. */
export async function prerender(options: PrerenderOptions) {
  const { root, outDir, prerenderDir, isStatic } = options
  const { createServer } = await import('../server/index')
  const app = await createServer({ root, outDir: relPosix(root, outDir), assetPrefix: options.assetPrefix, plugins: options.plugins, dev: options.isDev })
  mkdirSync(prerenderDir, { recursive: true })

  const stamp = `${Date.now()}-${++prerenderImportSeq}`
  for (const route of options.routes) {
    let urls: string[] = []
    if (!route.path.includes(':') && !route.path.includes('*')) {
      urls = [route.path]
    }
    else {
      const mod = await import(`${join(outDir, route.file)}?v=${stamp}`) as { paths?: () => Promise<string[]> | string[] }
      if (typeof mod.paths === 'function') {
        const returned: unknown = await mod.paths()
        assertPathUrls(returned, route.file)
        urls = returned
      }
      else {
        console.warn(`kay build${isStatic ? ' --static' : ''}: skipping dynamic route "${route.path}" (${route.file}) because it does not export a paths() function.`)
      }
    }

    if (urls.length === 0)
      continue

    for (const plugin of options.plugins) {
      if (plugin.prerenderPaths !== undefined)
        urls = await plugin.prerenderPaths(urls, route)
    }

    const map: Record<string, string> = {}
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      await Promise.all(urls.slice(i, i + CONCURRENCY).map(async (u) => {
        const res = await app.handle(new Request(`http://localhost${u}`))
        const isExplicit404 = u === '/404' && res.status === 404
        if (res.status !== 200 && !isExplicit404) {
          if (isStatic || res.status >= 500)
            throw new Error(`kay build${isStatic ? ' --static' : ''}: prerender route "${u}" returned HTTP ${res.status} (expected 200).`)
          return
        }
        const absHtml = resolvePrerenderHtmlPath(prerenderDir, u, isStatic)
        mkdirSync(dirname(absHtml), { recursive: true })
        writeFileSync(absHtml, await res.text())
        map[u] = relPosix(isStatic ? prerenderDir : outDir, absHtml)
      }))
    }
    route.prerendered = map
  }
  return app
}
