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

// Long enough for crawlers, short enough that a new post shows up the same hour without a restart.
const DATE_ONLY = /^\d{4}-\d\d-\d\d$/
const ROBOTS_PATH = /^[/*][^\r\n]*$/
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

    if (served.offer({ path: ROBOTS, owner: 'robots.txt', kind: 'kay', exported: true }))
      app.get(ROBOTS, ({ request }) => new Response(robotsTxt(rules, settings?.hosts ? `https://${settings.hosts[hostOf(request)!]}` : origin, settings, hostOf(request), options.base), { headers: { 'content-type': 'text/plain; charset=utf-8' } }))
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

  return `User-agent: *\nAllow: /\n${[...lines('Allow', rules.allow), ...lines('Disallow', rules.disallow)].map(line => `${line}\n`).join('')}\nSitemap: ${origin}${SITEMAP}\n`
}

// A page's `lastmod` for one URL as the sitemap writes it, a W3C date, or nothing when the page has none for it.
async function lastmodOf(setting: unknown, params: ListedParams, file: string): Promise<string> {
  const value: unknown = typeof setting === 'function' ? await (setting as (params: Record<string, string>) => unknown)(Object.fromEntries(Object.entries(params))) : setting

  if (value === undefined)
    return ''

  const date = new Date(value as Date | number | string)

  if ((typeof value === 'object' && !(value instanceof Date)) || Number.isNaN(date.getTime()))
    throw new KayError('page-settings-invalid', `kay: ${file}'s lastmod is ${JSON.stringify(value)}, which is no date: it takes a Date, a number of milliseconds or a string such as '2026-05-06'`)

  return `<lastmod>${typeof value === 'string' && DATE_ONLY.test(value) ? value : date.toISOString()}</lastmod>`
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
    const listed = async (params: ListedParams[]) => Promise.all(params.map(async value => ({ params: value, modified: await lastmodOf(pageSetting(module, 'lastmod'), value, file) })))

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
