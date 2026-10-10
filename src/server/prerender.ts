import type { KayConfig } from '../config'
import type { ClientBuild, PrerenderedPage } from './client'
import type { Route } from './routes'
import { mkdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { elementsIn, serverIslandOf } from '../compiler/ast'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { isAction } from '../runtime/action'
import { durationSeconds } from '../runtime/duration'
import { IMAGE_ROUTE } from '../runtime/image'
import { runInLocale } from '../runtime/locale-state'
import { setSite, standInReads } from '../runtime/site'
import { scanApi } from './api'
import { basePath } from './base'
import { setupCards } from './card'
import { PRERENDERED_DIR, readInlineStyles, readManifest, writeManifest } from './client'
import { loadI18n, localeCopies, stateFor } from './i18n'
import { applyImageConfig } from './image'
import { registerLoader } from './loader'
import { loadMatchers, matchedParams } from './params'
import { listedParams, pageEtag, pathOf, storedHeaders } from './prerendered'
import { renderPage } from './render'
import { refuseClashes, scanRoutes } from './routes'
import { configHead, siteOrigin } from './seo'
import { serverIslandModes } from './server-islands'
import { STAMP_HOLE } from './stamp'

const KAY_PREFIX = /^kay: /
const KAY_IMPORT = /\bfrom\s+['"]([^'"]+\.kay)['"]/g

// The image route in an attribute, `src`, `srcset` or a style's `url()`: a page whose text only names it, as documentation does, links nothing.
export const IMAGE_LINK = new RegExp(`="[^"]*${RegExp.escape(IMAGE_ROUTE)}\\?`)

// The pages a static export cannot hold, each named: a message for the person building, with no stack to read past.
export class ExportError extends Error {
  override name = 'ExportError'
}

export interface PrerenderOptions {
  // Every page, for `kay build --static`: one without params prerenders unless it opts out, and a page that cannot is reported rather than left to a server.
  exportAll?: boolean
}

// Renders every page whose server fence exports `prerender = true` into `.kay/client/pages`, listing them in the manifest the server boots from.
export async function prerenderPages(root: string, config: KayConfig, client: ClientBuild, options: PrerenderOptions = {}): Promise<number> {
  await registerLoader(root, config.settings)

  const manifest = await readManifest(root)

  if (!manifest)
    throw new Error('kay: no client build to add prerendered pages to; run buildClient first')

  const dir = join(root, '.kay', 'client', PRERENDERED_DIR)
  const { head } = await configHead(root, config, client.dir)

  if (config.inlineStyles === true)
    client.inlineStyles = await readInlineStyles(client, basePath(config.base))

  await setupCards({ dir: join(client.dir, '..'), clientDir: client.dir, fonts: (config.fonts?.length ?? 0) > 0, config: config.images?.card, name: config.seo?.name, quality: config.images?.quality, collect: true })

  const site = config.site === undefined ? undefined : siteOrigin(config.site) + basePath(config.base)

  setSite(site, config.trailingSlash, true)
  const maxDensity = applyImageConfig(config.images)
  const pages: Record<string, PrerenderedPage> = {}
  const paths = new Map<string, string>()

  const routesDir = resolve(root, config.routes ?? 'src/routes')
  const routes = await scanRoutes(routesDir)

  refuseClashes(routesDir, routes)
  const matchers = await loadMatchers(routesDir, routes)
  const i18n = config.i18n ? await loadI18n(root, config.i18n) : undefined

  async function prerenderRoute(route: Route, file: string, marked: boolean): Promise<void> {
    const module = await import(route.file) as Record<string, unknown>
    const revalidate = revalidatePeriod(file, module.revalidate)

    if (options.exportAll)
      refuseServerOnly(route, module)

    // A static export takes a page without params as it is, and so does a page holding a server island: what is not one is the same for everyone.
    const listed = (options.exportAll === true || marked) && module.prerender === undefined && route.params.length === 0 ? true : module.prerender

    if (options.exportAll && (listed === undefined || listed === false))
      throw new Error(listed === false ? 'kay: it exports prerender = false' : `kay: it takes ${route.params.join(', ')}, so \`prerender\` lists the values to export: export const prerender = [{ ${route.params.map(param => `${param}: '...'`).join(', ')} }]`)

    for (const params of await listedParams(route, file, 'prerender', listed)) {
      const path = pathOf(route, params)
      const matched = matchedParams(route, params, matchers)

      if (!matched)
        throw new Error(`kay: ${file} lists ${JSON.stringify(params)} in prerender, which its matchers refuse, so no request would reach it`)

      // One page per locale, each rendered in it.
      for (const copy of localeCopies(i18n?.settings, path)) {
        const request = new Request(`${copy.host === undefined ? 'http://localhost' : `https://${copy.host}`}${copy.path}`)
        // Guards run when the page is served, for whoever asks; the build renders what they let through.
        const reads = standInReads()
        const render = async () => renderPage({ ...route, guards: [] }, { request }, matched, client, { lang: config.lang, prefetch: config.prefetch, prerendering: true, head, base: basePath(config.base), maxDensity, offline: config.offline !== undefined })
        const response = await (i18n && copy.locale !== undefined ? runInLocale(stateFor(i18n, copy.locale, path, request), render) : render())

        if (response.status >= 500)
          throw new Error(`kay: prerendering ${copy.path} from ${file} failed with ${response.status}; the error is logged above`)

        // A static host answers every file with a 200, so a redirect or a 404 would go out as a page.
        if (options.exportAll && response.status !== 200)
          throw new Error(response.headers.has('location') ? `kay: ${copy.path} redirects to ${response.headers.get('location')}, which no static host does` : `kay: ${copy.path} answers ${response.status}, where a static host answers 200`)

        const html = await response.text()

        if (options.exportAll && IMAGE_LINK.test(html))
          throw new Error(`kay: ${copy.path} links an image only the image route resizes, such as one from images.dirs, and no file of it is exported`)

        const islands = serverIslandModes(html)
        const stamps = html.search(STAMP_HOLE) >= 0
        const readsSite = standInReads() > reads

        if (options.exportAll && readsSite)
          throw new Error('kay: it reads the site, through siteUrl() or siteOrigin(), which neither `site` in kay.config.ts nor SITE_URL sets')

        if (options.exportAll && islands.length > 0)
          throw new Error(`kay: it holds ${islands.length === 1 ? 'a server island' : `${islands.length} server islands`}, which only a server renders per request`)

        if (options.exportAll && stamps)
          throw new Error('kay: a form in it posts to an action with `minTime`, whose stamp only a server signs per request')

        if (islands.includes('defer') && client.entry === undefined)
          throw new Error(`kay: it defers a server island, which kay's browser entry fetches, and with no island and \`navigation: false\` the build has none; mark it \`server\` to render it inline instead`)

        const name = `${copy.key === '/' ? 'index' : copy.key.slice(1)}.html`
        const taken = paths.get(name)

        if (taken !== undefined)
          throw new Error(`kay: ${taken} and ${copy.key} would both be prerendered to ${name}; leave one out of prerender`)

        paths.set(name, copy.key)
        await mkdir(join(dir, name, '..'), { recursive: true })
        await Bun.write(join(dir, name), html)
        pages[copy.key] = { pattern: route.pattern, file: name, status: response.status, headers: storedHeaders(response.headers), etag: pageEtag(html), renderedAt: Date.now(), revalidate, ...islands.length > 0 ? { islands } : {}, ...stamps ? { stamps } : {}, ...readsSite ? { readsSite } : {} }
      }
    }
  }

  // What keeps a page from a static export, each named, so one build reports them all.
  const problems: string[] = []

  for (const route of routes) {
    // Read off the source first: a page that prerenders nothing is never imported, nor anything it imports.
    const marked = route.params.length === 0 && await reachesServerIsland(route.file)

    if (!options.exportAll && !marked && !await exportsPrerender(route.file))
      continue

    const file = relative(root, route.file)

    try {
      await prerenderRoute(route, file, marked)
    }
    catch (error) {
      if (!options.exportAll)
        throw error

      problems.push(`${file}: ${error instanceof Error ? error.message.replace(KAY_PREFIX, '') : String(error)}`)
    }
  }

  const apiProblems = options.exportAll ? (await scanApi(resolve(root, config.api ?? 'src/api'))).map(module => `${relative(root, module.file)}: an API module answers requests, which only a server does`) : []

  if (problems.length > 0 || apiProblems.length > 0)
    throw new ExportError(`kay: ${[count(problems.length, 'page'), count(apiProblems.length, 'API module')].filter(part => part !== '').join(' and ')} cannot be exported to static files, which no server answers for:\n${[...problems, ...apiProblems].map(problem => `  ${problem}`).join('\n')}`)

  await writeManifest(root, { ...manifest, pages, site })
  client.pages = new Map(Object.entries(pages))

  return Object.keys(pages).length
}

// What only a server can do: a guard decides per request, and an action takes a post.
function refuseServerOnly(route: Route, module: Record<string, unknown>): void {
  if (route.guards.length > 0)
    throw new Error('kay: a guard covers it, and only a server can run one per request')

  const action = Object.keys(module).find(name => isAction(module[name]))

  if (action !== undefined)
    throw new Error(`kay: it exports the action ${action}, which only a server can take`)
}

function count(problems: number, what: string): string {
  if (problems === 0)
    return ''

  return problems === 1 ? `1 ${what}` : `${problems} ${what}s`
}

// A page's `revalidate` export in seconds, or undefined when it has none.
function revalidatePeriod(file: string, value: unknown): number | undefined {
  return value === undefined ? undefined : durationSeconds(value, `${file}'s revalidate`)
}

// Whether the file's template, or that of a component it imports, however deep, marks a server island.
async function reachesServerIsland(file: string, seen = new Set<string>()): Promise<boolean> {
  if (seen.has(file))
    return false

  seen.add(file)

  const source = await Bun.file(file).text()

  if ([...elementsIn(parseKay(source).template)].some(element => serverIslandOf(element, source)))
    return true

  for (const [, specifier] of source.matchAll(KAY_IMPORT)) {
    let imported: string

    try {
      imported = Bun.resolveSync(specifier!, dirname(file))
    }
    catch {
      continue
    }

    if (await reachesServerIsland(imported, seen))
      return true
  }

  return false
}

async function exportsPrerender(file: string): Promise<boolean> {
  const source = await Bun.file(file).text()

  return analyzeServer(source, parseKay(source).server)?.exportNames.includes('prerender') ?? false
}
