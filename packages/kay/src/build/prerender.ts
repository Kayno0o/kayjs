// Build-time rendering: routes exporting `prerender = true` (and every route in a static export) are rendered through the real server and written as HTML.

import type { KayPlugin } from '../plugins/index'
import type { RouteManifestEntry } from './manifest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { inlineStyleHashes } from '../server/security'
import { relPosix } from './files'
import { assertPathUrls } from './routes'

const CONCURRENCY = 8
const SLASH_EDGES_RE = /^\/|\/$/g


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
  site?: string | undefined
  plugins: KayPlugin[]
  /** Plugins passed to `build()` itself, which the app runs with in place of its bundled config's. */
  pluginOverride?: KayPlugin[] | undefined
  isDev: boolean
  nodeEnv?: string | undefined
  isStatic: boolean
  /** Where the HTML lands: the static stage dir, or `<outDir>/prerendered`. */
  prerenderDir: string
  routes: RouteManifestEntry[]
}

/** Renders every route to HTML, records `route.prerendered`, and returns the server the pages were rendered with. */
export async function prerender(options: PrerenderOptions) {
  const { root, outDir, prerenderDir, isStatic } = options
  // Pages render with the runtime's own plugin instances, from the bundled config; `options.plugins` are the build's native ones.
  const { startBuiltApp } = await import('../server/loader')
  const { app, entry } = await startBuiltApp({ root, outDir: relPosix(root, outDir), assetPrefix: options.assetPrefix, site: options.site, plugins: options.pluginOverride, dev: options.isDev, nodeEnv: options.nodeEnv })
  mkdirSync(prerenderDir, { recursive: true })

  for (const route of options.routes) {
    let urls: string[] = []
    if (!route.path.includes(':') && !route.path.includes('*')) {
      urls = [route.path]
    }
    else {
      const mod = entry?.modules[route.file] as { paths?: () => Promise<string[]> | string[] } | undefined ?? {}
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
    const styleHashes: Record<string, string[]> = {}
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
        const html = await res.text()
        writeFileSync(absHtml, html)
        map[u] = relPosix(isStatic ? prerenderDir : outDir, absHtml)
        const hashes = inlineStyleHashes(html)
        if (hashes.length > 0)
          styleHashes[u] = hashes
      }))
    }
    route.prerendered = map
    route.prerenderedStyleHashes = Object.keys(styleHashes).length > 0 ? styleHashes : undefined
  }
  return app
}
