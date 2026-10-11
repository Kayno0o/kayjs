import type { LocaleSettings } from '../runtime/i18n'
import type { RouteMatch } from './actions'
import type { ServedRoute } from './guards'
import type { Matcher, RouterShape } from './params'
import type { Route } from './routes'
import { localePattern, localePrefixes } from './i18n'
import { isPlain, routerShapes, shapeParams } from './params'
import { refuseRouteNames } from './routes'
import { ServedPaths } from './served-paths'

export interface Candidate {
  route: ServedRoute
  shape: RouterShape
}

// The pages a router path serves in one locale, or those a locale translates elsewhere, which it sends there.
export interface LocaleServed {
  prefix: string
  candidates: Candidate[]
  untranslated?: true
}

export interface RouteTable {
  // Each path the router serves, with the pages serving it in each locale, in the order they are tried.
  paths: Map<string, Map<string | undefined, LocaleServed>>
  // Every shape each route is served under, in any locale, translated or not.
  shapes: Map<ServedRoute, RouterShape[]>
}

// Where a router path is served for each locale: under its prefix, bare for an unprefixed default or on its own host, and bare with no locale for every path that redirects to the visitor's.
function localeVariants(settings: LocaleSettings | undefined): { prefix: string, locale: string | undefined }[] {
  if (!settings)
    return [{ prefix: '', locale: undefined }]

  if (settings.hosts)
    return settings.locales.map(locale => ({ prefix: '', locale }))

  const prefixed = localePrefixes(settings).map(locale => ({ prefix: `/${locale}`, locale }))

  return [{ prefix: '', locale: settings.prefixDefault ? undefined : settings.defaultLocale }, ...prefixed]
}

// The shape as the page's file names its params, `/todos/:slug` for `/todos/:p2`.
function namedPath({ path, positions }: RouterShape): string {
  const names = new Map(positions)

  return path.split('/').map((segment, index) => segment.startsWith(':') ? `:${names.get(index)}` : segment).join('/')
}

// A page whose matcher refuses the URL passes it to the next, the one without a matcher last; several matchers on one path are tried in the order of their files' paths.
// Locales going by domain share a path, each host answering in its own; a path a locale translates is its alone, its untranslated one sending there.
// Each path is claimed in `served`: two pages serving one path stop the server, unless all but one check a matcher, untranslated.
export function routeTable(routes: ServedRoute[], settings: LocaleSettings | undefined, served = new ServedPaths()): RouteTable {
  const paths = new Map<string, Map<string | undefined, LocaleServed>>()
  const shapes = new Map<ServedRoute, RouterShape[]>(routes.map(route => [route, []]))
  const serve = (path: string, locale: string | undefined, served: LocaleServed) => {
    const locales = paths.get(path) ?? new Map<string | undefined, LocaleServed>()

    paths.set(path, locales)

    return locales.get(locale) ?? (locales.set(locale, served), served)
  }
  const variants = localeVariants(settings)
  const translated = (route: ServedRoute, locale: string | undefined) => settings && locale !== undefined ? localePattern(settings, route.pattern, locale) : route.pattern

  const scope = (locale: string | undefined) => settings?.hosts ? locale : undefined

  for (const { prefix, locale } of variants) {
    for (const route of routes) {
      const pattern = translated(route, locale)

      for (const shape of routerShapes(route, prefix, pattern)) {
        const claim = { path: shape.path, owner: route.file, kind: 'page' as const, scope: scope(locale), fallsThrough: !isPlain({ route, shape }), translated: pattern !== route.pattern }

        served.claim(claim, taken => taken.kind !== 'page'
          ? `kay: ${taken.owner} and ${route.file} both serve ${namedPath(shape)}`
          : claim.translated || taken.translated === true
            ? `kay: ${route.file} and ${taken.owner} are both served at ${pattern} in ${locale}, once i18n.paths translates them`
            : `kay: ${taken.owner} and ${route.file} both serve ${namedPath(shape)}; give one a matcher, [id=integer], for the other to take what it refuses`)
        serve(shape.path, locale, { prefix, candidates: [] }).candidates.push({ route, shape })
        shapes.get(route)!.push(shape)
      }
    }
  }

  for (const { prefix, locale } of variants) {
    for (const route of routes) {
      if (translated(route, locale) === route.pattern)
        continue

      for (const shape of routerShapes(route, prefix)) {
        const sent = serve(shape.path, locale, { prefix, candidates: [], untranslated: true })

        if (sent.untranslated === true) {
          served.offer({ path: shape.path, owner: route.file, kind: 'page', scope: scope(locale) })
          sent.candidates.push({ route, shape })
        }

        shapes.get(route)!.push(shape)
      }
    }
  }

  for (const locales of paths.values()) {
    for (const { candidates } of locales.values())
      candidates.sort((a, b) => Number(isPlain(a)) - Number(isPlain(b)) || a.route.file.localeCompare(b.route.file))
  }

  return { paths, shapes }
}

// Two pages serving one path stop the server, as does a name the router misreads; the server, the build and `kay check` call it, the editor, reading routes mid-edit, does not.
export function refuseClashes(routesDir: string, routes: Route[], served = new ServedPaths(), settings?: LocaleSettings): void {
  refuseRouteNames(routesDir, routes)
  routeTable(routes.map(route => ({ ...route, guards: [] })), settings, served)
}

// Reads a path as the router would for one route, under every locale's pattern, to give an action the params of the page it was posted from.
export function routeMatch(table: RouteTable, matchers: Map<string, Matcher>): RouteMatch {
  return (route, path) => {
    for (const shape of table.shapes.get(route) ?? []) {
      const params = shapeParams(shape, route, path, matchers)

      if (params)
        return params
    }

    return undefined
  }
}
