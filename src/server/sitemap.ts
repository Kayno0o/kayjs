import type { Elysia } from 'elysia'
import type { KayConfig, RobotsConfig, TrailingSlash } from '../config'
import type { LocaleSettings } from '../runtime/i18n'
import type { ServedRoute } from './guards'
import type { LocaleCopy } from './i18n'
import type { ListedParams } from './prerendered'
import type { ServedPaths } from './served-paths'
import { relative } from 'node:path'
import process from 'node:process'
import { NotFoundError } from 'elysia'
import { KayError } from '../compiler/errors'
import { escape } from '../runtime/escape'
import { kayLog } from '../runtime/log'
import { importModule } from './bundle'
import { fixedReply } from './compress'
import { hostLocale, localeCopies } from './i18n'
import { chainSetting, pageSetting } from './page-settings'
import { listedIn, listedParams, pathOf } from './prerendered'
import { onPublished } from './publishing'
import { reportServerError } from './report'
import { routeChain, slashedPath } from './routes'
import { ROBOTS, SITEMAP } from './site-paths'

const DATE_ONLY = /^\d{4}-\d\d-\d\d$/
// A date and time that names its zone, so every host reads it as the same moment.
const DATE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/
const ROBOTS_PATH = /^[/*][^\r\n]*$/
// How many `lastmod` calls of a page run at once, as each may read a database.
const LASTMOD_BATCH = 16

// What one sitemap file may hold, by the protocol: 50,000 URLs and 50 MB uncompressed.
export const SITEMAP_LIMITS = { urls: 50_000, bytes: 50 * 1024 * 1024 }
let activeLimits = SITEMAP_LIMITS

// For tests, which split a sitemap of a few dozen pages; not for apps. No argument restores the protocol's limits.
export function setSitemapLimits(limits = SITEMAP_LIMITS): void {
  activeLimits = limits
}
// How many parts a sitemap served in several files may have, 5 million URLs.
const MAX_PARTS = 100
// Long enough for crawlers, short enough that a new post shows up the same hour without a restart.
const CACHE_MS = 60 * 60 * 1000
// How long a sitemap built without some of its lastmods is kept, so the next crawl finds them back once the database answers.
const DEGRADED_MS = 60 * 1000

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
  // `files` holds the documents of the sitemap: the one `/sitemap.xml`, or its index followed by each part.
  const cached = new Map<string | undefined, { files: Promise<string[]>, replies: Map<number, (request: Request) => Promise<Response>>, at: number, degraded: boolean }>()
  const settings = options.locales

  // An entry published at its time shows in the sitemap then, not up to an hour later.
  const hear = () => onPublished(() => cached.clear())
  let stopHearing: (() => void) | undefined = hear()

  app.onStart(() => {
    stopHearing ??= hear()
  })
  app.onStop(() => {
    stopHearing?.()
    stopHearing = undefined
  })

  const hostOf = (request: Request) => settings?.hosts ? hostLocale(settings, request) : undefined
  const reading = (locale: string | undefined, report: (error: unknown) => void) => {
    let sitemap = cached.get(locale)

    if (options.dev || !sitemap || Date.now() - sitemap.at > (sitemap.degraded ? DEGRADED_MS : CACHE_MS)) {
      const publicOrigin = settings?.hosts && locale !== undefined ? `https://${settings.hosts[locale]}${options.base ?? ''}` : origin

      const built: typeof sitemap = { files: Promise.resolve([]), replies: new Map(), at: Date.now(), degraded: false }

      built.files = sitemapFiles(routes, origin, options.trailingSlash, settings, locale, (error) => {
        // A lastmod that is no date or a limit passed stays so on the next build: only an error the app threw, such as a database down, is worth building again soon.
        built.degraded ||= !(error instanceof KayError && error.code === 'page-settings-invalid')
        report(error)
      }, publicOrigin, options.base)
      cached.set(locale, sitemap = built)
    }

    return sitemap
  }
  const answer = async (request: Request, index: number) => {
    const locale = hostOf(request)
    const sitemap = reading(locale, error => reportServerError(error, request, options.onError))

    try {
      const files = await sitemap.files

      if (files[index] === undefined)
        throw new NotFoundError()

      let reply = sitemap.replies.get(index)

      if (!reply)
        sitemap.replies.set(index, reply = fixedReply(files[index], { 'content-type': 'application/xml; charset=utf-8', 'cache-control': `public, max-age=${(sitemap.degraded ? DEGRADED_MS : CACHE_MS) / 1000}` }))

      return await reply(request)
    }
    catch (error) {
      if (error instanceof NotFoundError)
        throw error

      cached.delete(locale)
      reportServerError(error, request, options.onError)

      return new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
  }

  if (served.offer({ path: SITEMAP, owner: 'the sitemap', kind: 'kay', exported: true })) {
    app.get(SITEMAP, async ({ request }) => answer(request, 0))

    // The parts of a sitemap past its limits, each a path of its own so no route of the app with a param is shadowed; a static export writes the ones that exist.
    for (let part = 1; part <= MAX_PARTS; part++) {
      if (served.offer({ path: `/sitemap-${part}.xml`, owner: 'the sitemap', kind: 'kay', exported: async () => (await reading(undefined, error => kayLog('warn', 'the sitemap leaves a lastmod out', error)).files)[part] === undefined ? [] : [`/sitemap-${part}.xml`] }))
        app.get(`/sitemap-${part}.xml`, async ({ request }) => answer(request, part))
    }
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
          written.set(locale, body = robotsTxt(rules, settings?.hosts ? `https://${settings.hosts[locale!]}${options.base ?? ''}` : origin, settings, locale, options.base))

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

// A `<urlset>` of `<url>` elements.
function urlset(urls: string[], settings: LocaleSettings | undefined): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${settings ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''}>${urls.join('')}</urlset>\n`
}

// The `<url>` elements in groups that each fit a sitemap file, always at least one.
export function sitemapParts(urls: string[], settings: LocaleSettings | undefined, limits = activeLimits): string[][] {
  const frame = Buffer.byteLength(urlset([], settings))
  const parts: string[][] = []
  let part: string[] = []
  let size = frame

  for (const url of urls) {
    const bytes = Buffer.byteLength(url)

    if (part.length > 0 && (part.length >= limits.urls || size + bytes > limits.bytes)) {
      parts.push(part)
      part = []
      size = frame
    }

    part.push(url)
    size += bytes
  }

  parts.push(part)

  return parts
}

// The documents of the sitemap: its one file, or, past the protocol's limits, an index followed by its parts, which `prefix` (the public origin with the mount point) locates.
export async function sitemapFiles(routes: ServedRoute[], origin: string, trailingSlash: TrailingSlash | undefined, settings: LocaleSettings | undefined, only: string | undefined, report: (error: unknown) => void, prefix: string, base = '', limits = activeLimits): Promise<string[]> {
  const parts = sitemapParts(await sitemapUrls(routes, origin, trailingSlash, settings, only, report, base), settings, limits)

  if (parts.length > MAX_PARTS) {
    report(new KayError('page-settings-invalid', `kay: the sitemap needs ${parts.length} files, and kay serves ${MAX_PARTS}; the URLs past them are left out`))
    parts.length = MAX_PARTS
  }

  if (parts.length === 1)
    return [urlset(parts[0]!, settings)]

  const index = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${parts.map((_, number) => `<sitemap><loc>${escape(`${prefix}/sitemap-${number + 1}.xml`)}</loc></sitemap>`).join('')}</sitemapindex>\n`

  return [index, ...parts.map(part => urlset(part, settings))]
}

// The whole sitemap in one document, past its limits too, for what only reads the URLs it lists.
export async function sitemapXml(routes: ServedRoute[], origin: string, trailingSlash?: TrailingSlash, settings?: LocaleSettings, only?: string): Promise<string> {
  return urlset(await sitemapUrls(routes, origin, trailingSlash, settings, only), settings)
}

// Every page a crawler can reach: a page without params unless it opts out, a page with params for the ones its `sitemap` or `prerender` export lists.
// A page behind a guard is left out unless its `sitemap` export puts it in.
// In a site of several locales, each copy of a page lists every other, `x-default` the default locale's; `only` keeps the copies of one locale, a domain's.
async function sitemapUrls(routes: ServedRoute[], origin: string, trailingSlash: TrailingSlash | undefined, settings: LocaleSettings | undefined, only: string | undefined, report: (error: unknown) => void = () => undefined, base = ''): Promise<string[]> {
  const lists = await Promise.all(routes.map(async (route) => {
    const file = relative(process.cwd(), route.file)
    const modules = await Promise.all(routeChain(route).files.map(async each => importModule<object>(each)))
    const module = modules.at(-1)!
    const sitemap = pageSetting(module, 'sitemap')
    const prerender = pageSetting(module, 'prerender')
    let lastmodReported = false
    // A lastmod that throws or is no date leaves that URL without one, and is reported once for the page.
    const modifiedOf = async (value: ListedParams) => {
      try {
        return await lastmodOf(pageSetting(module, 'lastmod'), value, file)
      }
      catch (error) {
        if (!lastmodReported) {
          lastmodReported = true
          report(error)
        }

        return ''
      }
    }
    const listed = async (params: ListedParams[]) => {
      const entries: { params: ListedParams, modified: string }[] = []

      for (let from = 0; from < params.length; from += LASTMOD_BATCH)
        entries.push(...await Promise.all(params.slice(from, from + LASTMOD_BATCH).map(async value => ({ params: value, modified: await modifiedOf(value) }))))

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

  const absolute = (copy: LocaleCopy) => escape(`${copy.host === undefined ? origin : `https://${copy.host}${base}`}${slashedPath(copy.path, trailingSlash)}`)
  const urls = routes.flatMap((route, index) => lists[index]!.flatMap(({ params, modified }) => {
    const copies = localeCopies(settings, pathOf(route, params)).filter(copy => listedIn(params, copy.locale, settings))
    const fallback = copies.find(copy => copy.locale === settings?.defaultLocale)
    const alternates = settings && fallback ? [...copies.map(copy => `<xhtml:link rel="alternate" hreflang="${copy.locale}" href="${absolute(copy)}"/>`), `<xhtml:link rel="alternate" hreflang="x-default" href="${absolute(fallback)}"/>`].join('') : ''

    return copies.filter(copy => only === undefined || copy.locale === only).map(copy => `<url><loc>${absolute(copy)}</loc>${modified}${alternates}</url>`)
  }))

  return urls
}
