import type { KayConfig } from '../config'
import type { ClientBuild, PrerenderedPage } from './client'
import type { Route } from './routes'
import { mkdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { PRERENDERED_DIR, readManifest, writeManifest } from './client'
import { registerLoader } from './loader'
import { renderPage } from './render'
import { scanRoutes } from './routes'

// Renders every page whose server fence exports `prerender = true` into `.kay/client/pages`, listing them in the manifest the server boots from.
export async function prerenderPages(root: string, config: KayConfig, client: ClientBuild): Promise<number> {
  registerLoader(root)

  const manifest = await readManifest(root)

  if (!manifest)
    throw new Error('kay: no client build to add prerendered pages to; run buildClient first')

  const dir = join(root, '.kay', 'client', PRERENDERED_DIR)
  const pages: Record<string, PrerenderedPage> = {}
  const paths = new Map<string, string>()

  for (const route of await scanRoutes(resolve(root, config.routes ?? 'src/routes'))) {
    // Read off the source first: a page that prerenders nothing is never imported, nor anything it imports.
    if (!await exportsPrerender(route.file))
      continue

    const file = relative(root, route.file)

    for (const params of await paramsToPrerender(route, file, (await import(route.file) as { prerender?: unknown }).prerender)) {
      const path = pathOf(route, params)
      // Guards run when the page is served, for whoever asks; the build renders what they let through.
      const response = await renderPage({ ...route, guards: [] }, { request: new Request(`http://localhost${path}`), params: elysiaParams(route, params) }, client, { lang: config.lang, prefetch: config.prefetch, prerendering: true })

      if (response.status >= 500)
        throw new Error(`kay: prerendering ${path} from ${file} failed with ${response.status}; the error is logged above`)

      const html = await response.text()
      const name = `${path === '/' ? 'index' : path.slice(1)}.html`
      const taken = paths.get(name)

      if (taken !== undefined)
        throw new Error(`kay: ${taken} and ${path} would both be prerendered to ${name}; leave one out of prerender`)

      paths.set(name, path)
      const headers: Record<string, string> = {}

      for (const [header, value] of response.headers) {
        if (header !== 'set-cookie')
          headers[header] = value
      }

      await mkdir(join(dir, name, '..'), { recursive: true })
      await Bun.write(join(dir, name), html)
      pages[path] = { pattern: route.pattern, file: name, status: response.status, headers, etag: `"${Bun.hash(html).toString(36)}"` }
    }
  }

  await writeManifest(root, { ...manifest, pages })
  client.pages = new Map(Object.entries(pages))

  return Object.keys(pages).length
}

async function exportsPrerender(file: string): Promise<boolean> {
  const source = await Bun.file(file).text()

  return analyzeServer(source, parseKay(source).server)?.exportNames.includes('prerender') ?? false
}

// `true` for a route without params; a list of params, or a function returning one, for the paths of a route with some.
async function paramsToPrerender(route: Route, file: string, prerender: unknown): Promise<Record<string, string>[]> {
  if (prerender === true) {
    if (route.params.length > 0)
      throw new Error(`kay: ${file} takes params, so \`prerender\` lists them: export const prerender = [{ ${route.params.map(name => `${name}: '...'`).join(', ')} }]`)

    return [{}]
  }

  if (prerender === false)
    return []

  const list: unknown = typeof prerender === 'function' ? await (prerender as () => unknown)() : prerender

  if (!Array.isArray(list))
    throw new Error(`kay: ${file} exports a prerender that is neither true, false, a list of params nor a function returning one`)

  for (const params of list) {
    if (typeof params !== 'object' || params === null || route.params.some(name => !isPathPart(name === route.catchAll, (params as Record<string, unknown>)[name])))
      throw new Error(`kay: ${file} prerenders ${JSON.stringify(params)}, which needs a string for each of ${route.params.join(', ')}, with no empty, . or .. segment`)
  }

  return list as Record<string, string>[]
}

// A segment, or for a catch-all a slash-separated run of them, that names a file inside the prerendered pages.
function isPathPart(catchAll: boolean, value: unknown): boolean {
  return typeof value === 'string' && (catchAll ? value.split('/') : [value]).every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

// The URL path the params fill in, each segment encoded; a catch-all keeps its slashes.
function pathOf(route: Route, params: Record<string, string>): string {
  return route.pattern.split('/').map((segment) => {
    if (segment === '*')
      return params[route.catchAll!]!.split('/').map(encodeURIComponent).join('/')

    return segment.startsWith(':') ? encodeURIComponent(params[segment.slice(1)]!) : segment
  }).join('/')
}

// What Elysia hands the page for that path: named params decoded, the catch-all still encoded.
function elysiaParams(route: Route, params: Record<string, string>): Record<string, string> {
  const raw: Record<string, string> = {}

  for (const name of route.params)
    raw[name === route.catchAll ? '*' : name] = name === route.catchAll ? params[name]!.split('/').map(encodeURIComponent).join('/') : params[name]!

  return raw
}
