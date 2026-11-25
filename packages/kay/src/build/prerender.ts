// Build-time rendering: routes exporting `prerender = true` (and every route in a static export) are rendered through the real server and written as HTML.

import type { KayPlugin } from '../plugins/index'
import type { RouteManifestEntry } from './manifest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { relPosix } from './files'

const CONCURRENCY = 8
const SLASH_EDGES_RE = /^\/|\/$/g

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

  const stamp = Date.now()
  for (const route of options.routes) {
    const mod = await import(`${join(outDir, route.file)}?v=${stamp}`) as { paths?: () => Promise<string[]> | string[] }
    let urls: string[] = []
    if (!route.path.includes(':') && !route.path.includes('*')) {
      urls = [route.path]
    }
    else if (typeof mod.paths === 'function') {
      urls = await mod.paths()
    }
    else if (isStatic) {
      console.warn(`kay build --static: skipping dynamic route "${route.path}" (${route.file}) because it does not export a paths() function.`)
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
          if (isStatic)
            throw new Error(`kay build --static: route "${u}" returned HTTP ${res.status} (expected 200).`)
          return
        }
        const absHtml = join(prerenderDir, u === '/' ? 'index.html' : `${u.replace(SLASH_EDGES_RE, '')}/index.html`)
        mkdirSync(dirname(absHtml), { recursive: true })
        writeFileSync(absHtml, await res.text())
        map[u] = relPosix(isStatic ? prerenderDir : outDir, absHtml)
      }))
    }
    route.prerendered = map
  }
  return app
}
