import type { LocaleSettings } from '../runtime/i18n'
import type { RouteMatch } from './actions'
import type { ServedRoute } from './guards'
import type { Matcher, RouterShape } from './params'
import { localePattern, localePrefixes } from './i18n'
import { isPlain, routerShapes, shapeParams } from './params'

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

// A page whose matcher refuses the URL passes it to the next, the one without a matcher last; several matchers on one path are tried in the order of their files' paths.
// Locales going by domain share a path, each host answering in its own; a path a locale translates is its alone, its untranslated one sending there.
export function routeTable(routes: ServedRoute[], settings: LocaleSettings | undefined): RouteTable {
  const paths = new Map<string, Map<string | undefined, LocaleServed>>()
  const shapes = new Map<ServedRoute, RouterShape[]>(routes.map(route => [route, []]))
  const serve = (path: string, locale: string | undefined, served: LocaleServed) => {
    const locales = paths.get(path) ?? new Map<string | undefined, LocaleServed>()

    paths.set(path, locales)

    return locales.get(locale) ?? (locales.set(locale, served), served)
  }
  const variants = localeVariants(settings)
  const translated = (route: ServedRoute, locale: string | undefined) => settings && locale !== undefined ? localePattern(settings, route.pattern, locale) : route.pattern

  for (const { prefix, locale } of variants) {
    for (const route of routes) {
      for (const shape of routerShapes(route, prefix, translated(route, locale))) {
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
        const served = serve(shape.path, locale, { prefix, candidates: [], untranslated: true })

        if (served.untranslated === true)
          served.candidates.push({ route, shape })

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
