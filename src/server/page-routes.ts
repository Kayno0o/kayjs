import type { Elysia } from 'elysia'
import type { TrailingSlash } from '../config'
import type { LocaleSettings } from '../runtime/i18n'
import type { ClientBuild } from './client'
import type { ServedRoute } from './guards'
import type { I18n } from './i18n'
import type { Writes } from './kept-pages'
import type { PageHook, RenderedPage } from './page-hook'
import type { Matcher, RouterShape } from './params'
import type { RenderOptions, RequestContext, ServedPage } from './render'
import type { Candidate, RouteTable } from './route-table'
import type { SpecialPages } from './routes'
import type { ServedPaths } from './served-paths'
import { join } from 'node:path'
import { localePath, splitLocale, untranslatedPath } from '../runtime/i18n'
import { localeState, runInLocale } from '../runtime/locale-state'
import { overHttps } from './actions'
import { PRERENDERED_DIR } from './client'
import { encodedCopies, encodedPath, filesUnder } from './compress'
import { noteRedirect } from './dev-notes'
import { handedOverFlash } from './flash'
import { cookieLocale, hostLocale, localeCookie, preferredLocale, prerenderKey, stateFor } from './i18n'
import { stillKept } from './kept-pages'
import { answeringRequest } from './log'
import { hookedResponse } from './page-hook'
import { matchedParams, positionalParams, slashSpelling } from './params'
import { inPreview, previewRequested, requestDrafts } from './preview'
import { requestId } from './protection'
import { hasFlash, renderPage, renderUnmatched, servePrerendered, sharedContext, withEditor } from './render'
import { reportServerError } from './report'
import { requestUrl } from './request-url'
import { revalidateStale } from './revalidate'
import { canonicalPath, withoutSlash } from './routes'
import { carryContext } from './security'
import { serveServerIslands } from './server-islands'
import { answered, SERVER_SPAN, traced } from './trace'

// The params come resolved, each matcher's value in place of its text.
export type PageResponder = (route: ServedRoute, params: Record<string, unknown>, context: RequestContext, url: URL) => Promise<Response>

export interface ResponderOptions {
  client: ClientBuild
  renderOptions: RenderOptions
  // The prerendered pages by route pattern, then by path.
  prerendered: Map<string, Map<string, ServedPage>>
  settings: LocaleSettings | undefined
  // What the extensions' page hooks did to the prerendered pages, done again to each the server renders afresh.
  transforms: PageHook[]
  pageFile: RenderedPage['file']
  // Counts the requests that can write, which a kept page is checked after.
  writes: Writes
}

// The prerendered pages by route pattern, then by path, with the compressed copies `kay build` wrote: only the brotli one is read into memory, at boot, the others served from their files.
// A page with no copy is held as text, which compression then knows too small or not worth compressing again.
export async function loadPrerendered(client: ClientBuild): Promise<Map<string, Map<string, ServedPage>>> {
  const byRoute = new Map<string, Map<string, ServedPage>>()
  const dir = join(client.dir, '..', PRERENDERED_DIR)
  const copies = encodedCopies(await filesUnder(dir))

  const loaded = await Promise.all([...client.pages.values()].map(async (page) => {
    const file = join(dir, page.file)
    const encodings = copies.get(file)
    const encoded: ServedPage['encoded'] = {}

    if (!encodings)
      return { html: await Bun.file(file).text(), encoded }

    for (const encoding of encodings)
      encoded[encoding] = encoding === 'br' ? await Bun.file(encodedPath(file, encoding)).bytes() : Bun.file(encodedPath(file, encoding))

    return { html: Bun.file(file), encoded }
  }))

  for (const [index, [path, page]] of [...client.pages].entries()) {
    let paths = byRoute.get(page.pattern)

    if (!paths)
      byRoute.set(page.pattern, paths = new Map<string, ServedPage>())

    paths.set(path, { status: page.status, etag: page.etag, headers: Object.entries(page.headers), renderedAt: page.renderedAt, revalidate: page.revalidate, islands: page.islands, stamps: page.stamps, readsSite: page.readsSite, kept: page.kept, pathname: page.pathname, reads: page.reads, token: page.token, ...loaded[index]! })
  }

  return byRoute
}

// Rendered for this visitor alone, kept by no cache.
async function forVisitor(render: () => Promise<Response>): Promise<Response> {
  const response = await render()

  response.headers.set('cache-control', 'private, no-store')
  response.headers.delete('etag')

  return response
}

// How a page answers one request: rendered afresh, or the copy `kay build` rendered, revalidated, with its server islands filled in.
export function pageResponder({ client, renderOptions, prerendered, settings, transforms, pageFile, writes }: ResponderOptions): PageResponder {
  // Rendered as `kay build` renders it: without the request, for whoever its guards let through; it starts within the request, so in its locale.
  const prerender = async (route: ServedRoute, params: Record<string, unknown>, url: URL, key: string) => hookedResponse(await renderPage({ ...route, guards: [] }, { request: new Request(`http://localhost${url.pathname}`) }, params, client, { ...renderOptions, prerendering: true }), transforms, key, localeState()?.locale ?? settings?.defaultLocale ?? '', pageFile)

  return async (route, params, context, url) => {
    const render = async () => renderPage(route, context, params, client, renderOptions)

    const preview = previewRequested(context.request)

    // Drafts shown, past any prerendered or cached copy.
    if (preview !== undefined)
      return forVisitor(async () => preview === 'edit' ? inPreview(render, true, requestDrafts(context.request)) : inPreview(render))

    const copies = prerendered.get(route.pattern)

    // A route `kay build` rendered nothing of is rendered without reading the path again.
    if (!copies)
      return render()

    const key = prerenderKey(settings, localeState()?.locale, canonicalPath(withoutSlash(url.pathname)))
    const page = copies.get(key)

    if (!page || (page.pathname !== undefined && page.pathname !== url.pathname))
      return render()

    // How a form post went is for the visitor who sent it.
    if (hasFlash(context.request) || handedOverFlash(context.request))
      return forVisitor(render)

    await revalidateStale(page, async () => prerender(route, params, url, key), error => reportServerError(error, context.request, renderOptions.onError))

    // A kept page is compared with a live render after a request that wrote, the first visit after it, and after a revalidation has refreshed its copy; the rest of the time this is a comparison of two numbers.
    if (page.kept === true && (page.checkedAt ?? 0) !== writes.count && !await stillKept(copies, key, page, writes, async () => prerender(route, params, url, key)))
      return render()

    const served = page.islands !== undefined || page.stamps === true ? await serveServerIslands(route, page, params, context, url, client, renderOptions) : undefined

    return served ?? servePrerendered(route, page, params, context, client, renderOptions)
  }
}

// The redirect giving a page one URL, so its relative links resolve one way, and `//host/` never sends a visitor off the site.
function slashRedirect(url: URL, shape: RouterShape, trailingSlash: TrailingSlash): Response | undefined {
  const wanted = slashSpelling(url.pathname, shape, trailingSlash)

  return wanted === url.pathname ? undefined : new Response(null, { status: 308, headers: { location: `${wanted}${url.search}` } })
}

// A temporary redirect, since another visitor goes elsewhere, which no shared cache may keep.
function localeRedirect(settings: LocaleSettings, request: Request, url: URL): Response {
  return new Response(null, { status: 307, headers: { 'location': `${localePath(settings, url.pathname, preferredLocale(settings, request))}${url.search}`, 'vary': 'cookie, accept-language', 'cache-control': 'private, no-cache' } })
}

// A visitor who followed a link of the site to another locale than the one they had is taken back to it from an unprefixed path; that response is theirs alone.
// A first visit, a crawler or a cache filling chose nothing, so their responses stay cacheable.
function remembered(response: Response, request: Request, locale: string): Response {
  if (response.status !== 200 || request.headers.get('sec-fetch-site') !== 'same-origin' || cookieLocale(request) === locale)
    return response

  response.headers.append('set-cookie', localeCookie(locale, overHttps(request)))
  response.headers.set('cache-control', 'private, no-cache')

  return response
}

export interface PageRoutes {
  table: RouteTable
  // What else took a path the table only offered, which it then leaves alone.
  served: ServedPaths
  matchers: Map<string, Matcher>
  i18n: I18n | undefined
  // The locales the config declares, or the site's one language.
  locales: I18n
  client: ClientBuild
  renderOptions: RenderOptions
  trailingSlash: TrailingSlash
  // The routes directory's own `_404.kay` and `_error.kay`, for a path no page serves.
  fallback: SpecialPages
  respond: PageResponder
}

// A route per path the router serves, then one answering what none of them does, each in the locale its prefix or its host names.
export function servePageRoutes(app: Elysia, { table, served: claims, matchers, i18n, locales, client, renderOptions, trailingSlash, fallback, respond }: PageRoutes): void {
  const settings = i18n?.settings
  const inImplicitLocale = async (url: URL, request: Request, run: () => Promise<Response>) => runInLocale(stateFor(locales, locales.settings.defaultLocale, url.pathname, request), run)

  const answer = async (candidates: Candidate[], context: RequestContext & { params: unknown }, url: URL): Promise<Response> => {
    for (const { route, shape } of candidates) {
      const text = positionalParams(shape, route, context.params as Record<string, string | null>)

      if (text === 'malformed')
        return new Response('Bad request', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } })

      const params = matchedParams(route, text, matchers)

      // A span per page request, its loads and render nested in it.
      if (params) {
        const { method } = context.request

        return traced(() => `${method} ${route.pattern}`, () => ({ kind: SERVER_SPAN, attributes: { 'http.request.method': method, 'http.route': route.pattern, 'url.path': url.pathname, 'kay.request.id': requestId(context.request) } }), async (span) => {
          const response = await respond(route, params, context, url)

          if (span)
            answered(span, response.status)

          return response
        })
      }
    }

    const last = candidates.at(-1)!.route

    return renderUnmatched(last.special, context, client, withEditor(last, renderOptions))
  }

  for (const [path, offered] of table.paths) {
    const served = new Map([...offered].filter(([, entry]) => entry.untranslated === undefined || claims.holds(entry.untranslated)))

    if (served.size === 0)
      continue

    const handle = async (context: RequestContext & { params: unknown }) => {
      const url = requestUrl(context.request)
      // On a host, the path is served in the host's locale, or not at all when only another locale's translation names it.
      const locale = settings?.hosts ? hostLocale(settings, context.request) : served.keys().next().value
      const own = served.get(locale)
      const redirect = slashRedirect(url, (own ?? served.values().next().value!).candidates[0]!.shape, trailingSlash)

      if (redirect) {
        noteRedirect(renderOptions.dev, context.request, 'the trailing slash setting')

        return redirect
      }

      if (!i18n || !settings)
        return inImplicitLocale(url, context.request, async () => answeringRequest(context.request, async () => answer(own!.candidates, context, url)))

      // With every locale prefixed, a path without one goes to the visitor's.
      if (locale === undefined) {
        noteRedirect(renderOptions.dev, context.request, 'the visitor\'s locale')

        return localeRedirect(settings, context.request, url)
      }

      const rest = url.pathname.slice(own?.prefix.length ?? 0) || '/'

      if (own?.untranslated !== undefined)
        return new Response(null, { status: 308, headers: { location: `${localePath(settings, rest, locale, url.host)}${url.search}` } })

      const state = stateFor(i18n, locale, untranslatedPath(settings, rest, locale), context.request)

      if (!own) {
        const last = served.values().next().value!.candidates.at(-1)!.route

        return runInLocale(state, async () => renderUnmatched(last.special, context, client, withEditor(last, renderOptions)))
      }

      const response = await runInLocale(state, async () => answeringRequest(context.request, async () => answer(own.candidates, context, url)))

      return settings.prefixDefault ? remembered(response, context.request, locale) : response
    }

    // The context is spread rather than handed over whole, which would make Elysia parse cookies and query for every request.
    app.get(path, async given => carryContext(given.set, await handle(sharedContext(given.request, () => ({ ...given })))))
  }

  // Every route above wins over this one, so it only answers what no page serves.
  if (!(fallback.notFound ?? fallback.error))
    return

  const unmatched = async (context: RequestContext) => {
    const url = requestUrl(context.request)

    if (!i18n || !settings)
      return inImplicitLocale(url, context.request, async () => renderUnmatched(fallback, context, client, renderOptions))

    const { locale, path } = splitLocale(settings, url.pathname)
    const answering = locale ?? (settings.hosts ? hostLocale(settings, context.request) : preferredLocale(settings, context.request))
    const response = await runInLocale(stateFor(i18n, answering, untranslatedPath(settings, path, answering), context.request), async () => renderUnmatched(fallback, context, client, renderOptions))

    // A path with no locale of its own is answered in the visitor's, which a shared cache must tell apart.
    if (locale === undefined && !settings.hosts)
      response.headers.append('vary', 'cookie, accept-language')

    return response
  }

  app.get('/*', async given => carryContext(given.set, await unmatched(sharedContext(given.request, () => ({ ...given })))))
}
