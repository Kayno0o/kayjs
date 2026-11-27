// Build-time rendering: routes exporting `prerender = true` (and every route in a static export) are rendered through the real server and written as HTML.

import type { KayPlugin } from '../plugins/index'
import type { RouteManifestEntry } from './manifest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { prerenderOrigin } from '../server/prerendered'
import { inlineStyleHashes } from '../server/security'
import { relPosix } from './files'
import { runPluginHook } from './plugin-host'
import { assertPathUrls } from './routes'

const CONCURRENCY = 8
const SLASH_EDGES_RE = /^\/|\/$/g
const TRAILING_SLASHES_RE = /\/+$/


function normalizePrerenderUrl(urlStr: string): string {
  const pathname = new URL(urlStr, 'http://localhost').pathname
  return pathname.length > 1 && pathname.endsWith('/') ? (pathname.replace(TRAILING_SLASHES_RE, '') || '/') : pathname
}

function resolvePrerenderPath(prerenderDir: string, urlStr: string, isStatic: boolean, contentType: string | null): string {
  const pathname = new URL(urlStr, 'http://localhost').pathname
  const trimmed = pathname.replace(SLASH_EDGES_RE, '')
  const lastSeg = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  const ext = extname(lastSeg).toLowerCase()
  const isHtml = (contentType ?? '').toLowerCase().includes('text/html')
  const preserveFile = ext !== '' && (ext === '.html' || ext === '.htm' || !isHtml)
  const rel = pathname === '/'
    ? 'index.html'
    : (isStatic && pathname === '/404')
        ? '404.html'
        : preserveFile
            ? trimmed
            : `${trimmed}/index.html`
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

// The build fails through the CLI, which prints only the message: the page's own error and its stack go in it.
export function pageFailure(head: string, error: unknown): Error {
  if (error === undefined)
    return new Error(`${head}.`)
  if (!(error instanceof Error))
    return new Error(`${head}: ${String(error)}`, { cause: error })
  const title = `${error.name}: ${error.message}`
  const stack = error.stack ?? ''
  const frames = stack.startsWith(title) ? stack.slice(title.length) : `\n${stack}`
  return new Error(`${head}: ${error.message}${frames}`, { cause: error })
}

/** Renders every route to HTML, records `route.prerendered`, and returns the server and entry the pages were rendered with. */
export async function prerender(options: PrerenderOptions) {
  const { root, outDir, prerenderDir, isStatic } = options
  // Pages render with the runtime's own plugin instances, from the bundled config; `options.plugins` are the build's native ones.
  const { startBuiltApp } = await import('../server/loader')
  const pageErrors = new Map<string, unknown>()
  const errorSink = ({ error, request }: { error: unknown, request: Request }): void => {
    if (!pageErrors.has(request.url))
      pageErrors.set(request.url, error)
  }
  const { app, entry } = await startBuiltApp({ root, outDir: relPosix(root, outDir), assetPrefix: options.assetPrefix, site: options.site, plugins: options.pluginOverride, dev: options.isDev, nodeEnv: options.nodeEnv, errorSink })
  const origin = prerenderOrigin(options.site)
  mkdirSync(prerenderDir, { recursive: true })

  for (const route of options.routes) {
    let urls: string[] = []
    let hasPathsFn = false
    if (!route.path.includes(':') && !route.path.includes('*')) {
      urls = [route.path]
    }
    else {
      const mod = entry?.modules[route.file] as { paths?: () => Promise<string[]> | string[] } | undefined ?? {}
      if (typeof mod.paths === 'function') {
        hasPathsFn = true
        const returned: unknown = await mod.paths()
        assertPathUrls(returned, route.file)
        urls = returned
      }
      else {
        console.warn(`kay build${isStatic ? ' --static' : ''}: skipping dynamic route "${route.path}" (${route.file}) because it does not export a paths() function.`)
      }
    }

    for (const plugin of options.plugins) {
      if (plugin.prerenderPaths !== undefined && (urls.length > 0 || hasPathsFn))
        urls = await runPluginHook(plugin, 'prerenderPaths', () => plugin.prerenderPaths!(urls, route))
    }

    urls = [...new Set(urls.map(normalizePrerenderUrl))]

    if (urls.length === 0) {
      if (hasPathsFn)
        route.prerendered = {}
      continue
    }

    const map: Record<string, string> = {}
    const styleHashes: Record<string, string[]> = {}
    for (let i = 0; i < urls.length; i += CONCURRENCY) {
      await Promise.all(urls.slice(i, i + CONCURRENCY).map(async (u) => {
        const request = new Request(`${origin}${u}`)
        const res = await app.handle(request)
        const isExplicit404 = u === '/404' && res.status === 404
        if (res.status !== 200 && !isExplicit404) {
          if (isStatic || res.status >= 500)
            throw pageFailure(`kay build: prerender route "${u}" answered HTTP ${res.status}`, pageErrors.get(request.url))
          return
        }
        const ct = res.headers.get('content-type')
        const absOut = resolvePrerenderPath(prerenderDir, u, isStatic, ct)
        mkdirSync(dirname(absOut), { recursive: true })
        if ((ct ?? '').toLowerCase().includes('text/html')) {
          const html = await res.text()
          writeFileSync(absOut, html)
          const hashes = inlineStyleHashes(html)
          if (hashes.length > 0)
            styleHashes[u] = hashes
        }
        else {
          writeFileSync(absOut, new Uint8Array(await res.arrayBuffer()))
        }
        map[u] = relPosix(isStatic ? prerenderDir : outDir, absOut)
      }))
    }
    route.prerendered = map
    route.prerenderedStyleHashes = Object.keys(styleHashes).length > 0 ? styleHashes : undefined
  }
  return { app, entry }
}
