import type { Elysia } from 'elysia'
import type { KayConfig, RobotsConfig, TrailingSlash } from '../config'
import type { LocaleSettings } from '../runtime/i18n'
import type { ServedRoute } from './guards'
import type { LocaleCopy } from './i18n'
import type { ListedParams } from './prerendered'
import type { ServedPaths } from './served-paths'
import { relative } from 'node:path'
import process from 'node:process'
import { KayError } from '../compiler/errors'
import { escape } from '../runtime/escape'
import { importModule } from './bundle'
import { fixedReply } from './compress'
import { hostLocale, localeCopies } from './i18n'
import { chainSetting, pageSetting } from './page-settings'
import { listedIn, listedParams, pathOf } from './prerendered'
import { reportServerError } from './report'
import { routeChain, slashedPath } from './routes'
import { ROBOTS, SITEMAP } from './site-paths'

const DATE_ONLY = /^\d{4}-\d\d-\d\d$/
// A date and time that names its zone, so every host reads it as the same moment.
const DATE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/
const ROBOTS_PATH = /^[/*][^\r\n]*$/
// How many `lastmod` calls of a page run at once, as each may read a database.
const LASTMOD_BATCH = 16
// Long enough for crawlers, short enough that a new post shows up the same hour without a restart.
const CACHE_MS = 60 * 60 * 1000

export interface SitemapOptions {
  dev?: boolean | undefined
  onError?: KayConfig['onError'] | undefined
  trailingSlash?: TrailingSlash | undefined
  locales?: LocaleSettings | undefined
  robots?: RobotsConfig | false | undefined
  // The mount point, which the paths of `robots` go under.
  base?: string | undefined
}

// `/sitemap.xml` and `/robots.txt` for a project with a `site`, unless something the app serves already takes that path.
export function serveSitemap(app: Elysia, served: ServedPaths, routes: ServedRoute[], origin: string, options: SitemapOptions = {}): void {
  // With locales by domain, each host lists its own pages: a sitemap may only name URLs of the host it is on.
  const cached = new Map<string | undefined, { xml: Promise<string>, reply: (request: Request) => Promise<Response>, at: number }>()
  const settings = options.locales
  const hostOf = (request: Request) => settings?.hosts ? hostLocale(settings, request) : undefined

  if (served.offer({ path: SITEMAP, owner: 'the sitemap', kind: 'kay', exported: true })) {
    app.get(SITEMAP, async ({ request }) => {
      const locale = hostOf(request)
      let sitemap = cached.get(locale)

      if (options.dev || !sitemap || Date.now() - sitemap.at > CACHE_MS) {
        const xml = sitemapXml(routes, origin, options.trailingSlash, settings, locale)

        cached.set(locale, sitemap = { xml, reply: fixedReply(xml, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': `public, max-age=${CACHE_MS / 1000}` }), at: Date.now() })
      }

      try {
        return await sitemap.reply(request)
      }
      catch (error) {
        cached.delete(locale)
        reportServerError(error, request, options.onError)

        return new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      }
    })
  }

  if (options.robots !== false) {
    const rules = robotsRules(options.robots)

    // The same for every request to a host, so written once per host.
    const written = new Map<string | undefined, string>()

    if (served.offer({ path: ROBOTS, owner: 'robots.txt', kind: 'kay', exported: true })) {
      app.get(ROBOTS, ({ request }) => {
        const locale = hostOf(request)
        let body = written.get(locale)

        if (body === undefined)
          written.set(locale, body = robotsTxt(rules, settings?.hosts ? `https://${settings.hosts[locale!]}` : origin, settings, locale, options.base))

        return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
      })
    }
  }
}

interface Rules {
  allow: string[]
  disallow: string[]
}

// A path or a pattern of the file, which a line break would turn into a rule of its own.
function robotsRules(config: RobotsConfig = {}): Rules {
  for (const [key, paths] of [['allow', config.allow], ['disallow', config.disallow]] as const) {
    for (const path of paths ?? []) {
      if (!ROBOTS_PATH.test(path))
        throw new KayError('config-invalid', `kay: robots.${key} holds '${path}', which is not a path of the site: it starts with / or * and has no line break`)
    }
  }

  return { allow: config.allow ?? [], disallow: config.disallow ?? [] }
}

// Every rule stands for the copy of its path in each locale the host serves, under the mount point.
function robotsTxt(rules: Rules, origin: string, settings: LocaleSettings | undefined, locale: string | undefined, base = ''): string {
  // A pattern starting with `*` matches wherever it falls, so it stays as it is.
  const lines = (name: string, paths: string[]) => paths.flatMap(path => path.startsWith('*') ? [`${name}: ${path}`] : [...new Set(localeCopies(settings, path).filter(copy => settings?.hosts === undefined || copy.locale === locale).map(copy => `${name}: ${base}${copy.path}`))])

  const disallowed = lines('Disallow', rules.disallow)
  // `Allow: /` against `Disallow: /` is a tie that crawlers settle for Allow, so blocking the whole site drops it.
  const everything = disallowed.includes('Disallow: /') ? '' : 'Allow: /\n'

  return `User-agent: *\n${everything}${[...lines('Allow', rules.allow), ...disallowed].map(line => `${line}\n`).join('')}\nSitemap: ${origin}${SITEMAP}\n`
}

// A page's `lastmod` for one URL as the sitemap writes it, a W3C date, or nothing when the page has none for it.
async function lastmodOf(setting: unknown, params: ListedParams, file: string): Promise<string> {
  // The params without the symbols kay lists locales under.
  const value: unknown = typeof setting === 'function' ? await (setting as (params: Record<string, string>) => unknown)(Object.fromEntries(Object.entries(params))) : setting

  if (value === undefined || value === null)
    return ''

  const invalid = () => new KayError('page-settings-invalid', `kay: ${file}'s lastmod is ${JSON.stringify(value)}, which is no date: it takes a Date, a number of milliseconds, or a string such as '2026-05-06' or '2026-05-06T10:00:00Z'`)

  if (typeof value === 'string' && DATE_ONLY.test(value)) {
    // A day that does not exist, such as February 31st, rolls over to another when read.
    const day = new Date(value)

    if (Number.isNaN(day.getTime()) || !day.toISOString().startsWith(value))
      throw invalid()

    return `<lastmod>${value}</lastmod>`
  }

  if (!(value instanceof Date) && typeof value !== 'number' && !(typeof value === 'string' && DATE_TIME.test(value)))
    throw invalid()

  const date = new Date(value)

  if (Number.isNaN(date.getTime()))
    throw invalid()

  return `<lastmod>${date.toISOString()}</lastmod>`
}

// Every page a crawler can reach: a page without params unless it opts out, a page with params for the ones its `sitemap` or `prerender` export lists.
// A page behind a guard is left out unless its `sitemap` export puts it in.
// In a site of several locales, each copy of a page lists every other, `x-default` the default locale's; `only` keeps the copies of one locale, a domain's.
export async function sitemapXml(routes: ServedRoute[], origin: string, trailingSlash?: TrailingSlash, settings?: LocaleSettings, only?: string): Promise<string> {
  const lists = await Promise.all(routes.map(async (route) => {
    const file = relative(process.cwd(), route.file)
    const modules = await Promise.all(routeChain(route).files.map(async each => importModule<object>(each)))
    const module = modules.at(-1)!
    const sitemap = pageSetting(module, 'sitemap')
    const prerender = pageSetting(module, 'prerender')
    const listed = async (params: ListedParams[]) => {
      const entries: { params: ListedParams, modified: string }[] = []

      for (let from = 0; from < params.length; from += LASTMOD_BATCH)
        entries.push(...await Promise.all(params.slice(from, from + LASTMOD_BATCH).map(async value => ({ params: value, modified: await lastmodOf(pageSetting(module, 'lastmod'), value, file) }))))

      return entries
    }

    if (chainSetting(modules, 'noindex') === true)
      return []

    if (sitemap !== undefined)
      return listed(await listedParams(route, file, 'sitemap', sitemap, settings))

    if (route.guards.length > 0)
      return []

    if (route.params.length === 0)
      return listed([{}])

    return prerender === undefined ? [] : listed(await listedParams(route, file, 'prerender', prerender, settings))
  }))

  const absolute = (copy: LocaleCopy) => escape(`${copy.host === undefined ? origin : `https://${copy.host}`}${slashedPath(copy.path, trailingSlash)}`)
  const urls = routes.flatMap((route, index) => lists[index]!.flatMap(({ params, modified }) => {
    const copies = localeCopies(settings, pathOf(route, params)).filter(copy => listedIn(params, copy.locale, settings))
    const fallback = copies.find(copy => copy.locale === settings?.defaultLocale)
    const alternates = settings && fallback ? [...copies.map(copy => `<xhtml:link rel="alternate" hreflang="${copy.locale}" href="${absolute(copy)}"/>`), `<xhtml:link rel="alternate" hreflang="x-default" href="${absolute(fallback)}"/>`].join('') : ''

    return copies.filter(copy => only === undefined || copy.locale === only).map(copy => `<url><loc>${absolute(copy)}</loc>${modified}${alternates}</url>`)
  }))

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${settings ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''}>${urls.join('')}</urlset>\n`
}
