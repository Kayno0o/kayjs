import type { SiteSeo } from '../check/seo'
import type { TrailingSlash } from '../config'
import type { LocaleSettings } from '../runtime/i18n'
import type { DevHead } from './dev'
import type { ServedRoute } from './guards'
import { configSeoLints, DESCRIPTION_LENGTH, pageSeoLints } from '../check/seo'
import { isCrossSite } from './actions'
import { routerPath } from './base'
import { withoutSlash } from './routes'
import { sitemapXml } from './sitemap'

const HEADER = 'x-kay-dev'
const LOC = /<loc>(.*?)<\/loc>/g

export interface HeadSite {
  config: SiteSeo
  routes: ServedRoute[]
  base: string
  trailingSlash?: TrailingSlash | undefined
  locales?: LocaleSettings | undefined
}

// The server's side of the Head tab: the page's live head goes through the rules `kay check` applies to a built page, and the sitemap says whether it lists the page. Only the page's path and head are read, from the dev tool.
export async function devHead(request: Request, { config, routes, base, trailingSlash, locales }: HeadSite): Promise<Response> {
  if (request.headers.get(HEADER) === null || isCrossSite(request))
    return new Response(null, { status: 403 })

  let body: { path?: unknown, head?: unknown }

  try {
    body = await request.json() as typeof body
  }
  catch {
    return new Response(null, { status: 400 })
  }

  if (typeof body.path !== 'string' || typeof body.head !== 'string')
    return new Response(null, { status: 400 })

  // The sitemap names pages as a browser does, under `base`; the lints name them as the router does.
  const full = withoutSlash(body.path)
  const path = routerPath(full, base)
  let sitemap: DevHead['sitemap'] = 'none'
  let sitemapError: string | undefined

  if (config.site !== undefined) {
    try {
      sitemap = (await listedPaths(routes, config.site, trailingSlash, locales)).has(full) ? 'listed' : 'unlisted'
    }
    catch (error) {
      sitemap = 'error'
      sitemapError = error instanceof Error ? error.message : String(error)
    }
  }

  const problems = pageSeoLints(config, [{ path, file: '', html: `<html>${body.head}</html>`, noindex: sitemap === 'unlisted', sitemap: false, search: false }])

  problems.unshift(...configSeoLints(config, '', [], true).filter(problem => problem.code === 'missing-site'))

  return Response.json({
    descriptionLength: DESCRIPTION_LENGTH,
    site: config.site,
    sitemap,
    sitemapError,
    problems: problems.map(({ code, severity, message, note, help }) => ({ code, severity: severity ?? 'warning', message, note, help })),
  } satisfies DevHead)
}

// The sitemap runs every route module and every app `sitemap` and `prerender` function, so a server's paths are listed once, on the first read, and kept until it restarts; a failed listing is tried again.
const listings = new WeakMap<ServedRoute[], Promise<Set<string>>>()

async function listedPaths(routes: ServedRoute[], site: string, trailingSlash: TrailingSlash | undefined, locales: LocaleSettings | undefined): Promise<Set<string>> {
  let listing = listings.get(routes)

  if (listing === undefined) {
    listing = readListing(routes, site, trailingSlash, locales)
    listings.set(routes, listing)
  }

  try {
    return await listing
  }
  catch (error) {
    listings.delete(routes)

    throw error
  }
}

async function readListing(routes: ServedRoute[], site: string, trailingSlash: TrailingSlash | undefined, locales: LocaleSettings | undefined): Promise<Set<string>> {
  const xml = await sitemapXml(routes, site, trailingSlash, locales)

  return new Set([...xml.matchAll(LOC)].map(([, loc]) => withoutSlash(new URL(loc!.replaceAll('&amp;', '&')).pathname)))
}
