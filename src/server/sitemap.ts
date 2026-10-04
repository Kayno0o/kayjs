import type { Elysia } from 'elysia'
import type { KayConfig, TrailingSlash } from '../config'
import type { LocaleSettings } from '../runtime/i18n'
import type { ServedRoute } from './guards'
import type { LocaleCopy } from './i18n'
import { relative } from 'node:path'
import process from 'node:process'
import { escape } from '../runtime/escape'
import { importModule } from './bundle'
import { localeCopies } from './i18n'
import { listedParams, pathOf } from './prerender'
import { reportServerError } from './report'
import { servedPaths, slashedPath } from './routes'

export const SITEMAP = '/sitemap.xml'
export const ROBOTS = '/robots.txt'
// Long enough for crawlers, short enough that a new post shows up the same hour without a restart.
const CACHE_MS = 60 * 60 * 1000

interface PageExports {
  sitemap?: unknown
  prerender?: unknown
}

export interface SitemapOptions {
  dev?: boolean
  onError?: KayConfig['onError']
  trailingSlash?: TrailingSlash
  locales?: LocaleSettings
}

// `/sitemap.xml` and `/robots.txt` for a project with a `site`, unless a public file or a page already serves that path.
export function serveSitemap(app: Elysia, routes: ServedRoute[], origin: string, taken: Set<string>, options: SitemapOptions = {}): void {
  const served = new Set([...taken, ...servedPaths(routes)])
  let cached: { xml: Promise<string>, at: number } | undefined

  if (!served.has(SITEMAP)) {
    app.get(SITEMAP, async ({ request }) => {
      if (options.dev || !cached || Date.now() - cached.at > CACHE_MS)
        cached = { xml: sitemapXml(routes, origin, options.trailingSlash, options.locales), at: Date.now() }

      try {
        return new Response(await cached.xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': `public, max-age=${CACHE_MS / 1000}` } })
      }
      catch (error) {
        cached = undefined
        reportServerError(error, request, options.onError)

        return new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      }
    })
  }

  if (!served.has(ROBOTS))
    app.get(ROBOTS, () => new Response(`User-agent: *\nAllow: /\n\nSitemap: ${origin}${SITEMAP}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
}

// Every page a crawler can reach: a page without params unless it opts out, a page with params for the ones its `sitemap` or `prerender` export lists.
// A page behind a guard is left out unless its `sitemap` export puts it in.
export async function sitemapXml(routes: ServedRoute[], origin: string, trailingSlash?: TrailingSlash, settings?: LocaleSettings): Promise<string> {
  const lists = await Promise.all(routes.map(async (route) => {
    const file = relative(process.cwd(), route.file)
    const module = await importModule<PageExports>(route.file)

    if (module.sitemap !== undefined)
      return listedParams(route, file, 'sitemap', module.sitemap)

    if (route.guards.length > 0)
      return []

    if (route.params.length === 0)
      return [{}]

    return module.prerender === undefined ? [] : listedParams(route, file, 'prerender', module.prerender)
  }))

  const absolute = (copy: LocaleCopy) => escape(`${copy.host === undefined ? origin : `https://${copy.host}`}${slashedPath(copy.path, trailingSlash)}`)
  // In a site of several locales, each copy of a page lists every other.
  const urls = routes.flatMap((route, index) => lists[index]!.flatMap((params) => {
    const copies = localeCopies(settings, pathOf(route, params))
    const alternates = settings ? copies.map(copy => `<xhtml:link rel="alternate" hreflang="${copy.locale}" href="${absolute(copy)}"/>`).join('') : ''

    return copies.map(copy => `<url><loc>${absolute(copy)}</loc>${alternates}</url>`)
  }))

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${settings ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''}>${urls.join('')}</urlset>\n`
}
