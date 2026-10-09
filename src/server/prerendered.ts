import type { Route } from './routes'
import { isCollection } from '../content'

// The headers a prerendered page is served with: the cookies its render set were for no one.
export function storedHeaders(headers: Headers): Record<string, string> {
  const stored: Record<string, string> = {}

  for (const [header, value] of headers) {
    if (header !== 'set-cookie')
      stored[header] = value
  }

  return stored
}

export function pageEtag(html: string): string {
  return `"${Bun.hash(html).toString(36)}"`
}

// The paths a page export such as `prerender` lists: `true` for a route without params; a list of params, a function returning one, or a content collection, for a route with some.
export async function listedParams(route: Route, file: string, name: string, value: unknown): Promise<Record<string, string>[]> {
  if (isCollection(value)) {
    if (route.params.length !== 1)
      throw new Error(`kay: ${file} takes ${route.params.length === 0 ? 'no params' : route.params.join(', ')}, so a collection cannot fill them: its entries give one slug each, for a route with one param`)

    const param = route.params[0]!
    const entries = await value.all()
    const nested = entries.find(entry => entry.slug.includes('/') && param !== route.catchAll)

    if (nested)
      throw new Error(`kay: ${file} takes one segment as ${param}, but the entry ${nested.file} has the slug ${nested.slug}; name the page [...${param}].kay for nested entries`)

    return entries.map(entry => ({ [param]: entry.slug }))
  }

  if (value === true) {
    if (route.params.length > 0)
      throw new Error(`kay: ${file} takes params, so \`${name}\` lists them: export const ${name} = [{ ${route.params.map(param => `${param}: '...'`).join(', ')} }]`)

    return [{}]
  }

  if (value === false)
    return []

  const list: unknown = typeof value === 'function' ? await (value as () => unknown)() : value

  if (!Array.isArray(list))
    throw new Error(`kay: ${file} exports a ${name} that is neither true, false, a list of params, a function returning one, nor a collection`)

  for (const params of list) {
    if (typeof params !== 'object' || params === null || route.params.some(param => !isPathPart(route, param, (params as Record<string, unknown>)[param])))
      throw new Error(`kay: ${file} lists ${JSON.stringify(params)} in ${name}, which needs a string for each of ${route.params.join(', ')}, with no empty, . or .. segment${route.optional ? `; ${route.optional.join(', ')} may be left out` : ''}`)
  }

  return list as Record<string, string>[]
}

// A segment, or for a catch-all a slash-separated run of them, that names a file inside the prerendered pages; an optional param may be left out.
function isPathPart(route: Route, param: string, value: unknown): boolean {
  if (value === undefined && route.optional?.includes(param))
    return true

  return typeof value === 'string' && (param === route.catchAll ? value.split('/') : [value]).every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

// The URL path the params fill in, each segment encoded as the server looks pages up; a catch-all keeps its slashes, an optional param left out leaves its segment out.
export function pathOf(route: Route, params: Record<string, string>): string {
  const path = route.pattern.split('/').flatMap((segment) => {
    if (segment === '*')
      return [params[route.catchAll!]!.split('/').map(encodeURIComponent).join('/')]

    if (segment.endsWith('?'))
      return params[segment.slice(1, -1)] === undefined ? [] : [encodeURIComponent(params[segment.slice(1, -1)]!)]

    return [encodeURIComponent(segment.startsWith(':') ? params[segment.slice(1)]! : segment)]
  }).join('/')

  return path === '' ? '/' : path
}
