import type { KayConfig } from '../config'
import type { ClientBuild, PrerenderedPage } from './client'
import type { Route } from './routes'
import { mkdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { isCollection } from '../content'
import { runInLocale } from '../runtime/i18n.server'
import { PRERENDERED_DIR, readManifest, writeManifest } from './client'
import { loadI18n, localeCopies, stateFor } from './i18n'
import { registerLoader } from './loader'
import { loadMatchers, matchedParams } from './params'
import { renderPage } from './render'
import { refuseClashes, scanRoutes } from './routes'
import { configHead } from './seo'

// Renders every page whose server fence exports `prerender = true` into `.kay/client/pages`, listing them in the manifest the server boots from.
export async function prerenderPages(root: string, config: KayConfig, client: ClientBuild): Promise<number> {
  registerLoader(root)

  const manifest = await readManifest(root)

  if (!manifest)
    throw new Error('kay: no client build to add prerendered pages to; run buildClient first')

  const dir = join(root, '.kay', 'client', PRERENDERED_DIR)
  const head = await configHead(root, config, client.dir)
  const pages: Record<string, PrerenderedPage> = {}
  const paths = new Map<string, string>()

  const routesDir = resolve(root, config.routes ?? 'src/routes')
  const routes = await scanRoutes(routesDir)

  refuseClashes(routesDir, routes)
  const matchers = await loadMatchers(routesDir, routes)
  const i18n = config.i18n ? await loadI18n(root, config.i18n) : undefined

  for (const route of routes) {
    // Read off the source first: a page that prerenders nothing is never imported, nor anything it imports.
    if (!await exportsPrerender(route.file))
      continue

    const file = relative(root, route.file)

    const module = await import(route.file) as { prerender?: unknown, revalidate?: unknown }
    const revalidate = revalidatePeriod(file, module.revalidate)

    for (const params of await listedParams(route, file, 'prerender', module.prerender)) {
      const path = pathOf(route, params)
      const matched = matchedParams(route, params, matchers)

      if (!matched)
        throw new Error(`kay: ${file} lists ${JSON.stringify(params)} in prerender, which its matchers refuse, so no request would reach it`)

      // One page per locale, each rendered in it.
      for (const copy of localeCopies(i18n?.settings, path)) {
        const request = new Request(`${copy.host === undefined ? 'http://localhost' : `https://${copy.host}`}${copy.path}`)
        // Guards run when the page is served, for whoever asks; the build renders what they let through.
        const render = async () => renderPage({ ...route, guards: [] }, { request }, matched, client, { lang: config.lang, prefetch: config.prefetch, prerendering: true, head })
        const response = await (i18n && copy.locale !== undefined ? runInLocale(stateFor(i18n, copy.locale, path, request), render) : render())

        if (response.status >= 500)
          throw new Error(`kay: prerendering ${copy.path} from ${file} failed with ${response.status}; the error is logged above`)

        const html = await response.text()
        const name = `${copy.key === '/' ? 'index' : copy.key.slice(1)}.html`
        const taken = paths.get(name)

        if (taken !== undefined)
          throw new Error(`kay: ${taken} and ${copy.key} would both be prerendered to ${name}; leave one out of prerender`)

        paths.set(name, copy.key)
        await mkdir(join(dir, name, '..'), { recursive: true })
        await Bun.write(join(dir, name), html)
        pages[copy.key] = { pattern: route.pattern, file: name, status: response.status, headers: storedHeaders(response.headers), etag: pageEtag(html), renderedAt: Date.now(), revalidate }
      }
    }
  }

  await writeManifest(root, { ...manifest, pages })
  client.pages = new Map(Object.entries(pages))

  return Object.keys(pages).length
}

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

// A page's `revalidate` export: seconds, or undefined when it has none.
function revalidatePeriod(file: string, value: unknown): number | undefined {
  if (value === undefined)
    return undefined

  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error(`kay: ${file} exports a revalidate that is not a positive number of seconds`)

  return value
}

async function exportsPrerender(file: string): Promise<boolean> {
  const source = await Bun.file(file).text()

  return analyzeServer(source, parseKay(source).server)?.exportNames.includes('prerender') ?? false
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
