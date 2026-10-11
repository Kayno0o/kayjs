import type { Elysia } from 'elysia'
import type { KayConfig, TrailingSlash } from '../config'
import type { LocaleSettings } from '../runtime/i18n'
import type { ServedRoute } from './guards'
import type { LocaleCopy } from './i18n'
import type { ServedPaths } from './served-paths'
import { relative } from 'node:path'
import process from 'node:process'
import { escape } from '../runtime/escape'
import { importModule } from './bundle'
import { hostLocale, localeCopies } from './i18n'
import { pageSetting } from './page-settings'
import { listedIn, listedParams, pathOf } from './prerendered'
import { reportServerError } from './report'
import { slashedPath } from './routes'

export const SITEMAP = '/sitemap.xml'
export const ROBOTS = '/robots.txt'
// Long enough for crawlers, short enough that a new post shows up the same hour without a restart.
const CACHE_MS = 60 * 60 * 1000

export interface SitemapOptions {
  dev?: boolean | undefined
  onError?: KayConfig['onError'] | undefined
  trailingSlash?: TrailingSlash | undefined
  locales?: LocaleSettings | undefined
}

// `/sitemap.xml` and `/robots.txt` for a project with a `site`, unless something the app serves already takes that path.
export function serveSitemap(app: Elysia, served: ServedPaths, routes: ServedRoute[], origin: string, options: SitemapOptions = {}): void {
  // With locales by domain, each host lists its own pages: a sitemap may only name URLs of the host it is on.
  const cached = new Map<string | undefined, { xml: Promise<string>, at: number }>()
  const settings = options.locales
  const hostOf = (request: Request) => settings?.hosts ? hostLocale(settings, request) : undefined

  if (served.offer({ path: SITEMAP, owner: 'the sitemap', kind: 'kay', exported: true })) {
    app.get(SITEMAP, async ({ request }) => {
      const locale = hostOf(request)
      let sitemap = cached.get(locale)

      if (options.dev || !sitemap || Date.now() - sitemap.at > CACHE_MS)
        cached.set(locale, sitemap = { xml: sitemapXml(routes, origin, options.trailingSlash, settings, locale), at: Date.now() })

      try {
        return new Response(await sitemap.xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': `public, max-age=${CACHE_MS / 1000}` } })
      }
      catch (error) {
        cached.delete(locale)
        reportServerError(error, request, options.onError)

        return new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      }
    })
  }

  if (served.offer({ path: ROBOTS, owner: 'robots.txt', kind: 'kay', exported: true }))
    app.get(ROBOTS, ({ request }) => new Response(`User-agent: *\nAllow: /\n\nSitemap: ${settings?.hosts ? `https://${settings.hosts[hostOf(request)!]}` : origin}${SITEMAP}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
}

// Every page a crawler can reach: a page without params unless it opts out, a page with params for the ones its `sitemap` or `prerender` export lists.
// A page behind a guard is left out unless its `sitemap` export puts it in.
// In a site of several locales, each copy of a page lists every other, `x-default` the default locale's; `only` keeps the copies of one locale, a domain's.
export async function sitemapXml(routes: ServedRoute[], origin: string, trailingSlash?: TrailingSlash, settings?: LocaleSettings, only?: string): Promise<string> {
  const lists = await Promise.all(routes.map(async (route) => {
    const file = relative(process.cwd(), route.file)
    const module = await importModule<object>(route.file)
    const sitemap = pageSetting(module, 'sitemap')
    const prerender = pageSetting(module, 'prerender')

    if (pageSetting(module, 'noindex') === true)
      return []

    if (sitemap !== undefined)
      return listedParams(route, file, 'sitemap', sitemap, settings)

    if (route.guards.length > 0)
      return []

    if (route.params.length === 0)
      return [{}]

    return prerender === undefined ? [] : listedParams(route, file, 'prerender', prerender, settings)
  }))

  const absolute = (copy: LocaleCopy) => escape(`${copy.host === undefined ? origin : `https://${copy.host}`}${slashedPath(copy.path, trailingSlash)}`)
  const urls = routes.flatMap((route, index) => lists[index]!.flatMap((params) => {
    const copies = localeCopies(settings, pathOf(route, params)).filter(copy => listedIn(params, copy.locale, settings))
    const fallback = copies.find(copy => copy.locale === settings?.defaultLocale)
    const alternates = settings && fallback ? [...copies.map(copy => `<xhtml:link rel="alternate" hreflang="${copy.locale}" href="${absolute(copy)}"/>`), `<xhtml:link rel="alternate" hreflang="x-default" href="${absolute(fallback)}"/>`].join('') : ''

    return copies.filter(copy => only === undefined || copy.locale === only).map(copy => `<url><loc>${absolute(copy)}</loc>${alternates}</url>`)
  }))

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${settings ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''}>${urls.join('')}</urlset>\n`
}
