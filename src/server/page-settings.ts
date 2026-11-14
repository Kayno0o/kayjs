import type { Collection } from '../content'
import type { PageSettings } from '../runtime'
import { KayError } from '../compiler/errors'
import { SEO_SETTINGS } from '../compiler/page-settings'
import { isRouteOf } from '../content/claims'
import { registeredCollections } from '../content/edit-registry'
import { durationSeconds } from '../runtime/duration'

// A setting of a page module: its key of `export const page`, those of `seo` read from there first.
export function pageSetting(module: object, name: keyof PageSettings): unknown {
  const page = (module as { page?: PageSettings }).page

  return SEO_SETTINGS.includes(name) ? ((page?.seo as Record<string, unknown> | undefined)?.[name] ?? page?.[name]) : page?.[name]
}

// A text of a page's `seo` group, as it is written.
export function pageSeo(module: object, name: 'title' | 'description' | 'image' | 'canonical'): unknown {
  return (module as { page?: PageSettings }).page?.seo?.[name]
}

const CACHE_FORMS = '`\'1h\'`, `{ browser, shared, swr }`, `\'private\'` or `false`'

function invalidCache(file: string, problem: string): KayError {
  return new KayError('page-settings-invalid', `kay: the \`cache\` of ${file} ${problem}; it takes ${CACHE_FORMS}`)
}

// The seconds of a duration in a page's `cache`, or undefined for a part it leaves out.
function cacheSeconds(file: string, value: unknown): number | undefined {
  if (value === undefined)
    return undefined

  try {
    return durationSeconds(value, `the \`cache\` of ${file}`)
  }
  catch {
    throw invalidCache(file, `is ${JSON.stringify(value) ?? String(value)}, which is no duration such as '250ms', '5m' or '30d'`)
  }
}

// What a module's `cache` says as the `ttl` and `cacheControl` the prerender reads: a duration is a `ttl`, an object sets each part of the header and `shared` is the `ttl`, `'private'` and `false` set the header alone.
function cacheOf(file: string, cache: NonNullable<PageSettings['cache']>): { ttl: unknown, cacheControl: unknown } {
  if (cache === false)
    return { ttl: undefined, cacheControl: false }

  if (cache === 'private')
    return { ttl: undefined, cacheControl: 'private' }

  if (typeof cache !== 'object') {
    cacheSeconds(file, cache)

    return { ttl: cache, cacheControl: undefined }
  }

  if (cache === null || Array.isArray(cache))
    throw invalidCache(file, `is ${cache === null ? 'null' : 'a list'}`)

  const [browser, shared, swr] = [cache.browser, cache.shared, cache.swr].map(value => cacheSeconds(file, value))
  const parts = [`public, max-age=${Math.ceil(browser ?? 0)}`, shared === undefined ? '' : `s-maxage=${Math.ceil(shared)}`, swr === undefined ? '' : `stale-while-revalidate=${Math.ceil(swr)}`]

  return { ttl: cache.shared, cacheControl: parts.filter(part => part !== '').join(', ') }
}

// A setting along a route's modules, layouts outermost first and the page last: the innermost that sets it wins, so a page may undo what its layouts say.
export function chainSetting(modules: object[], name: keyof PageSettings): unknown {
  for (let index = modules.length - 1; index >= 0; index--) {
    const value = pageSetting(modules[index]!, name)

    if (value !== undefined)
      return value
  }

  return undefined
}

// A page's lifetime and `cache-control` along its route: the `cache` of the innermost module that sets one, else its `ttl` and `cacheControl` as they were written before 1.105, each the innermost that sets it.
export function chainCache(file: string, modules: object[]): { ttl: unknown, cacheControl: unknown } {
  let ttl: unknown
  let cacheControl: unknown

  for (let index = modules.length - 1; index >= 0; index--) {
    const page = (modules[index] as { page?: PageSettings }).page

    if (page?.cache !== undefined) {
      const given = cacheOf(file, page.cache)

      return { ttl: ttl ?? given.ttl, cacheControl: cacheControl ?? given.cacheControl }
    }

    ttl ??= page?.ttl
    cacheControl ??= page?.cacheControl
  }

  return { ttl, cacheControl }
}

interface PageRoute {
  pattern: string
  params: readonly string[]
}

// The answers for the collections registered last, by pattern, so a request does not match every collection's route again.
let known: { registered: object, byPattern: Map<string, Collection<unknown>[]> } | undefined

// The collections whose `route` is this page's pattern, in the content config's order: the page of one param is where their entries are shown.
export function routedCollections(route: PageRoute): Collection<unknown>[] {
  if (route.params.length !== 1 || route.pattern.includes('?'))
    return []

  const registered = registeredCollections()

  if (known?.registered !== registered)
    known = { registered, byPattern: new Map() }

  let found = known.byPattern.get(route.pattern)

  if (found === undefined) {
    found = registered.flatMap(([, collection]) => collection.options.route !== undefined && collection.options.single !== true && isRouteOf(collection.options.route, route.pattern) ? [collection] : [])
    known.byPattern.set(route.pattern, found)
  }

  return found
}

// A page's `prerender`: what it sets, else the collection whose `route` is the page's pattern, so a page needs no export to list its entries.
export function pagePrerender(module: object, route: PageRoute): unknown {
  return pageSetting(module, 'prerender') ?? routedCollections(route)[0]
}
