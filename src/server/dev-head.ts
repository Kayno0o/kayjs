import type { SiteSeo } from '../check/seo'
import type { TrailingSlash } from '../config'
import type { LocaleSettings } from '../runtime/i18n'
import type { DevHead } from './dev'
import type { ServedRoute } from './guards'
import { configSeoLints, DESCRIPTION_LENGTH, pageSeoLints } from '../check/seo'
import { isCrossSite } from './actions'
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

  const path = withoutSlash(body.path.startsWith(base) ? body.path.slice(base.length) || '/' : body.path)
  const listed = config.site === undefined ? undefined : await listedPaths(routes, config.site, trailingSlash, locales)
  const sitemap = listed === undefined ? 'none' : listed.has(path) ? 'listed' : 'unlisted'
  const problems = pageSeoLints(config, [{ path, file: '', html: `<html>${body.head}</html>`, noindex: sitemap !== 'listed', sitemap: false, search: false }])

  problems.unshift(...configSeoLints(config, '', [], true).filter(problem => problem.code === 'missing-site'))

  return Response.json({
    descriptionLength: DESCRIPTION_LENGTH,
    site: config.site,
    sitemap,
    problems: problems.map(({ code, severity, message, note, help }) => ({ code, severity: severity ?? 'warning', message, note, help })),
  } satisfies DevHead)
}

async function listedPaths(routes: ServedRoute[], site: string, trailingSlash: TrailingSlash | undefined, locales: LocaleSettings | undefined): Promise<Set<string>> {
  const xml = await sitemapXml(routes, site, trailingSlash, locales)

  return new Set([...xml.matchAll(LOC)].map(([, loc]) => withoutSlash(new URL(loc!.replaceAll('&amp;', '&')).pathname)))
}
