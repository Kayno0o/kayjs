import type { RenderedPage } from '../check/seo'
import type { ErrorName, ExportProblem } from '../compiler/errors'
import type { Project } from '../project'
import type { ClientBuild, PrerenderedPage } from './client'
import type { ListedParams } from './prerendered'
import type { Scan, Stop } from './pure-page'
import type { Route } from './routes'
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { resolveFrom } from '../build/files'
import { elementsIn, serverIslandOf } from '../compiler/ast'
import { exportProblem, KayError } from '../compiler/errors'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { isAction } from '../runtime/action'
import { durationSeconds } from '../runtime/duration'
import { IMAGE_ROUTE } from '../runtime/image'
import { runInLocale } from '../runtime/locale-state'
import { standInReads } from '../runtime/site'
import { withPageToken } from '../runtime/uid.server'
import { projectApi } from './api-modules'
import { PRERENDERED_DIR, readManifest, writeManifest } from './client'
import { exportedEndpoints } from './endpoints'
import { localeCopies, stateFor } from './i18n'
import { LIVE_MARK } from './live'
import { readsOf } from './page-reads'
import { chainSetting, pageSetting } from './page-settings'
import { matchedParams } from './params'
import { listedIn, listedParams, pageEtag, pageToken, pathOf, storedHeaders } from './prerendered'
import { keptScan } from './pure-page'
import { renderPage } from './render'
import { scanEndpoints, slashedPath } from './routes'
import { serverIslandModes } from './server-islands'
import { setupPages } from './setup'
import { STAMP_HOLE } from './stamp'

const PARTS = new Intl.ListFormat('en-GB')
const KAY_IMPORT = /\bfrom\s+['"]([^'"]+\.kay)['"]/g

// The image route in an attribute, `src`, `srcset` or a style's `url()`: a page whose text only names it, as documentation does, links nothing.
export const IMAGE_LINK = new RegExp(`=(?:"[^"]*|'[^']*)${RegExp.escape(IMAGE_ROUTE)}\\?`)

// The pages a static export cannot hold, each named: a message for the person building, with no stack to read past.
export class ExportError extends Error {
  override name = 'ExportError'

  // Each problem with its own code, the file it is in leading its message.
  constructor(message: string, readonly problems: ExportProblem[]) {
    super(message)
  }

  get code(): ErrorName {
    return this.problems[0]?.code ?? 'export-page-error'
  }
}

// What keeps a page that nothing marks from being kept; `keep` when the page said it should be.
export interface KeptStop extends Stop {
  keep: boolean
  // The page it stopped, by route pattern: a layout or a module it imports may be what stopped many.
  route: string
  // What to do about it, when `drop what it reads` is not it.
  fix?: string | undefined
}

export interface PrerenderOptions {
  // Every page, for `kay build --static`: one without params prerenders unless it opts out, and a page that cannot is reported rather than left to a server.
  exportAll?: boolean
  // Receives every page rendered, for `kay build` to lint their heads.
  rendered?: RenderedPage[] | undefined
  // Receives the pages that answered a status other than 200, which the head lints and the search index leave out, for `kay build` to weigh the scripts they load.
  others?: Pick<RenderedPage, 'file' | 'html'>[] | undefined
  // Receives every route of the project, for `kay build` to weigh what each loads.
  routes?: Route[] | undefined
  // Receives, by route pattern, what stopped each page from being kept without being asked for, and whether the page said `keep: true`, for `kay build` to show it.
  stops?: Map<string, KeptStop> | undefined
  // Hears how many of the routes it went through, those it prerenders nothing of included.
  onRoute?: ((done: number, total: number) => void) | undefined
}

// Renders every page whose server fence exports `prerender = true` into `pages` under the project's `paths.output` (`.kay/client`), listing them in the manifest the server boots from.
export async function prerenderPages(project: Project, client: ClientBuild, options: PrerenderOptions = {}): Promise<number> {
  const { root, config, paths: { routes: routesDir, output } } = project
  const manifest = await readManifest(root, output)

  if (!manifest)
    throw new KayError('export-no-client-build', 'kay: no client build to add prerendered pages to; run buildClient first')

  const dir = join(output, PRERENDERED_DIR)
  const { mounts, routes, matchers, i18n, locales, site, renderOptions } = await setupPages(project, () => client, true)

  options.routes?.push(...routes)

  const pages: Record<string, PrerenderedPage> = {}
  const paths = new Map<string, string>()
  // The tokens the pages so far draw their ids from.
  const tokens = new Set<string>()
  // The files of pages kept without being asked for, which a page that was asked for takes the place of.
  const kept = new Set<string>()
  // What each file read, for the next route to reach it again.
  const scans = new Map<string, Promise<Scan>>()

  // `auto` is a page nothing marks, which the build keeps because it provably reads nothing from its request: it is skipped, never failed, as soon as one render shows otherwise.
  // Gives what writes the route, once every locale of it has rendered, so a route given up on leaves nothing behind.
  async function prerenderRoute(route: Route, file: string, marked: boolean, auto = false, keep = false, readsPathname = false): Promise<(() => Promise<void> | void)[]> {
    const pending: (() => Promise<void> | void)[] = []
    // Nothing is written for a page given up on, whose reason is kept for the build to show.
    const skip = (why: string) => {
      options.stops?.set(route.pattern, { file: route.file, line: 0, why, keep, route: route.pattern })

      return []
    }
    // The names this route's own copies take, which two of them may not share.
    const reserved = new Map<string, string>()

    const module = await import(route.file) as Record<string, unknown>
    // A layout's `revalidate`, `noindex` and `search` apply to every page under it, the innermost setting winning.
    const chain = [...await Promise.all(route.layouts.map(async layout => import(layout) as Promise<object>)), module]
    const revalidate = revalidatePeriod(file, chainSetting(chain, 'revalidate'))

    // A copy that goes stale is rendered again for every visitor with the request a page reads, which an unmarked page was never asked to.
    if (auto && revalidate !== undefined)
      return skip('sets `revalidate`, which has a stale copy render again for every visitor')

    const prerender = pageSetting(module, 'prerender')

    if (options.exportAll)
      refuseServerOnly(route, module, config.requireGuards)

    // A static export takes a page without params as it is, and so does a page holding a server island: what is not one is the same for everyone.
    const listed = (options.exportAll === true || marked || auto) && prerender === undefined && route.params.length === 0 ? true : prerender

    if (options.exportAll && (listed === undefined || listed === false))
      throw new KayError('export-needs-params', listed === false ? 'kay: its prerender is false' : `kay: it takes ${route.params.join(', ')}, so \`prerender\` lists the values to export: export const page = { prerender: [{ ${route.params.map(param => `${param}: '...'`).join(', ')} }] }`)

    for (const params of await listedParams(route, file, 'prerender', listed, i18n?.settings)) {
      const path = pathOf(route, params)
      const matched = matchedParams(route, params, matchers)

      if (!matched)
        throw new KayError('export-needs-params', `kay: ${file} lists ${JSON.stringify(params)} in prerender, which its matchers refuse, so no request would reach it`)

      // The weight of the page's words, worked out once for the locales it is served in.
      let weighed: Promise<number | false> | undefined
      const weight = async () => weighed ??= searchWeight(chainSetting(chain, 'search'), params, file)

      // One page per locale, each rendered in it.
      for (const copy of localeCopies(i18n?.settings, path).filter(copy => listedIn(params, copy.locale, i18n?.settings))) {
        // Rendered at the path the server answers it at, which `trailingSlash` spells.
        const served = slashedPath(copy.path, config.trailingSlash)
        const request = new Request(`${copy.host === undefined ? 'http://localhost' : `https://${copy.host}`}${served}`)
        // Guards run when the page is served, for whoever asks; the build renders what they let through.
        const reads = standInReads()
        // onError is the app's for requests it answers; the build logs what a prerendered page throws.
        const render = async () => renderPage({ ...route, guards: [] }, { request }, matched, client, { ...renderOptions, onError: undefined, prerendering: true })
        const inLocale = async () => runInLocale(stateFor(locales, copy.locale ?? locales.settings.defaultLocale, path, request), render)
        // The ids a page draws keep apart from those of the page it is swapped for, so each page has a token of its own, the same on every render and build; the body is read within it, as a stream draws its ids as it is read.
        const token = pageToken(copy.key, tokens)

        tokens.add(token)
        const read = async () => {
          const rendered = await inLocale()

          return { response: rendered, html: await rendered.text() }
        }
        const once = async () => withPageToken(token, read)
        const { result: { response, html }, reads: dataRead } = await readsOf(once)

        if (auto && response.status !== 200)
          return skip(`answers ${response.status} when rendered without a request`)

        if (response.status >= 500)
          throw new KayError('export-page-status', `kay: prerendering ${copy.path} from ${file} failed with ${response.status}; the error is logged above`)

        // A static host answers every file with a 200, so a redirect or a 404 would go out as a page.
        if (options.exportAll && response.status !== 200)
          throw new KayError('export-page-status', response.headers.has('location') ? `kay: ${copy.path} redirects to ${response.headers.get('location')}, which no static host does` : `kay: ${copy.path} answers ${response.status}, where a static host answers 200`)

        // Two renders of the same page differ when it draws on something the source does not show, a counter or a clock behind a function.
        if (auto && (await once()).html !== html)
          return skip('renders differently each time, as it draws on something its source does not show')

        if (options.exportAll && IMAGE_LINK.test(html))
          throw new KayError('export-image-route', `kay: ${copy.path} links an image only the image route resizes, such as one from images.dirs, and no file of it is exported`)

        const islands = serverIslandModes(html)
        const stamps = html.search(STAMP_HOLE) >= 0
        const readsSite = standInReads() > reads
        const livesOn = html.includes(LIVE_MARK)

        if (auto && (islands.length > 0 || stamps || readsSite || livesOn))
          return skip(unkeptBy(islands.length > 0, stamps, livesOn))

        if (livesOn)
          throw new KayError('export-server-render', 'kay: it reads a live value, which only a server holds and signs the connection to per request; drop `prerender` from `export const page`, or read the value in a component the page does not render at build time')

        if (options.exportAll && readsSite)
          throw new KayError('export-site-url', 'kay: it reads the site, through siteUrl() or siteOrigin(), which neither `site` in kay.config.ts, SITE_URL nor ORIGIN sets')

        if (options.exportAll && islands.length > 0)
          throw new KayError('export-server-render', `kay: it holds ${islands.length === 1 ? 'a server island' : `${islands.length} server islands`}, which only a server renders per request`)

        if (options.exportAll && stamps)
          throw new KayError('export-server-render', 'kay: a form in it posts to an action with `minTime` or `proofOfWork`, or holds a `workChallenge`, whose stamp or challenge only a server signs per request')

        if (islands.includes('defer') && client.entry === undefined)
          throw new KayError('export-server-render', `kay: it defers a server island, which kay's browser entry fetches, and with no island and \`navigation: false\` the build has none; mark it \`server\` to render it inline instead`)

        const name = `${copy.key === '/' ? 'index' : copy.key.slice(1)}.html`
        const taken = reserved.get(name) ?? paths.get(name)

        if (taken !== undefined && kept.has(name) && !auto) {
          // A page the author asked for outranks one the build kept on its own.
          delete pages[taken]
          kept.delete(name)
        }
        else if (taken !== undefined) {
          if (auto)
            return skip(`would share its prerendered file ${name} with ${taken}`)

          throw new KayError('export-path-clash', `kay: ${taken} and ${copy.key} would both be prerendered to ${name}; leave one out of prerender`)
        }

        reserved.set(name, copy.key)
        pending.push(async () => {
          paths.set(name, copy.key)

          if (auto)
            kept.add(name)

          await mkdir(join(dir, name, '..'), { recursive: true })
          await Bun.write(join(dir, name), html)
        })

        if (response.status === 200 && !auto) {
          const noindex = chainSetting(chain, 'noindex') === true
          const indexed = config.search === true && !noindex && !guardedPage(route, config.requireGuards)

          options.rendered?.push({ path: copy.path, file: route.file, locale: copy.locale, html, noindex, sitemap: pageSetting(module, 'sitemap') !== undefined, search: indexed ? await weight() : false })
        }
        else if (!auto) {
          options.others?.push({ file: route.file, html })
        }

        const stored: PrerenderedPage = { pattern: route.pattern, locale: copy.locale ?? locales.settings.defaultLocale, file: name, status: response.status, headers: storedHeaders(response.headers), etag: pageEtag(html), renderedAt: Date.now(), revalidate, ...islands.length > 0 ? { islands } : {}, ...stamps ? { stamps } : {}, ...readsSite ? { readsSite } : {}, ...auto ? { kept: true } : {}, ...auto && readsPathname ? { pathname: new URL(request.url).pathname } : {}, ...dataRead.length > 0 ? { reads: dataRead } : {}, ...token === pageToken(copy.key) ? {} : { token } }

        pending.push(() => {
          pages[copy.key] = stored
        })
      }
    }

    return pending
  }

  // What keeps a page from a static export, each named, so one build reports them all.
  const problems: ExportProblem[] = []

  for (const [index, route] of routes.entries()) {
    options.onRoute?.(index, routes.length)

    // Read off the source first: a page that prerenders nothing, and is not shown to read nothing, is never imported, nor anything it imports.
    const marked = route.params.length === 0 && await reachesServerIsland(route.file)

    const settings = await pageFlags(route.file)
    const asked = marked || options.exportAll === true || settings.prerender !== undefined
    const keep = !asked && settings.keep

    // `keep` asks the build to prerender the page, which `prerender: false` forbids.
    if (settings.keep && settings.prerender === 'false' && !options.exportAll) {
      options.stops?.set(route.pattern, { file: route.file, line: 0, why: '`prerender: false` contradicts `keep: true`', keep: true, route: route.pattern, fix: 'remove one of the two' })

      continue
    }

    const { stop, pathname } = asked ? { stop: undefined, pathname: false } : await stopOf(route, scans, root)
    const auto = !asked && stop === undefined

    if (!asked && !auto) {
      // A route taking params and lists none is not a page the build looked at, so it gets a stop only when it says it is to be kept.
      if (route.params.length === 0 || keep)
        options.stops?.set(route.pattern, { ...stop!, keep, route: route.pattern, ...route.params.length > 0 && { fix: 'list the pages to keep in `prerender`, or remove `keep`' } })

      continue
    }

    const file = relative(root, route.file)

    let writes: Awaited<ReturnType<typeof prerenderRoute>>

    try {
      writes = await prerenderRoute(route, file, marked, auto, keep, pathname)
    }
    catch (error) {
      // A page kept on the strength of its source alone is rendered per request when it will not render here.
      if (auto) {
        options.stops?.set(route.pattern, { file: route.file, line: 0, why: `does not render at build: ${firstLine(error instanceof Error ? error.message : String(error))}`, keep, route: route.pattern })

        continue
      }

      if (!options.exportAll)
        throw error

      problems.push(exportProblem(file, error))

      continue
    }

    for (const write of writes)
      await write()
  }

  options.onRoute?.(routes.length, routes.length)

  const apiProblems: ExportProblem[] = options.exportAll ? (await projectApi(root, config)).map(module => ({ code: 'export-api-module', message: `${relative(root, module.file)}: an API module answers requests, which only a server does; a file such as src/routes/llms.txt.ts exporting GET is written to a file` })) : []
  const endpointProblems = options.exportAll ? (await exportedEndpoints(root, await scanEndpoints(routesDir, mounts), config.requireGuards)).problems : []

  if (problems.length > 0 || apiProblems.length > 0 || endpointProblems.length > 0)
    throw new ExportError(`kay: ${PARTS.format([count(problems.length, 'page'), count(endpointProblems.length, 'endpoint'), count(apiProblems.length, 'API module')].filter(part => part !== ''))} cannot be exported to static files, which no server answers for:\n${[...problems, ...endpointProblems, ...apiProblems].map(problem => `  ${problem.message}`).join('\n')}`, [...problems, ...endpointProblems, ...apiProblems])

  await writeManifest(root, { ...manifest, pages, site }, output)
  client.pages = new Map(Object.entries(pages))

  return Object.keys(pages).length
}

// Whether a guard answers for the page, `requireGuards` refusing one no guard covers: its words stay out of the public search index.
function guardedPage(route: Route, required: boolean | undefined): boolean {
  return route.guards.length > 0 || (required === true && route.open !== true)
}

// What only a server can do: a guard decides per request, and an action takes a post.
function refuseServerOnly(route: Route, module: Record<string, unknown>, required: boolean | undefined): void {
  if (route.guards.length > 0)
    throw new KayError('export-guard', 'kay: a guard covers it, and only a server can run one per request')

  if (required === true && route.open !== true)
    throw new KayError('export-guard', 'kay: requireGuards is on and no guard covers it; set `guards: false` in its `page` to export it')

  const action = Object.keys(module).find(name => isAction(module[name]))

  if (action !== undefined)
    throw new KayError('export-action', `kay: it exports the action ${action}, which only a server can take`)
}

function count(problems: number, what: string): string {
  if (problems === 0)
    return ''

  return problems === 1 ? `1 ${what}` : `${problems} ${what}s`
}

// A page's `search` as the index takes it, `false` to leave the page out or the weight its words count.
async function searchWeight(setting: unknown, params: ListedParams, file: string): Promise<number | false> {
  let value = setting

  if (typeof setting === 'function') {
    try {
      // The params without the symbols kay lists locales under.
      value = await (setting as (params: Record<string, string>) => unknown)(Object.fromEntries(Object.entries(params)))
    }
    catch (error) {
      throw new KayError('page-settings-invalid', `kay: the \`search\` of ${file} threw for ${JSON.stringify(Object.fromEntries(Object.entries(params)))}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  if (value === undefined)
    return 1

  if (value === false)
    return false

  const weight = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as { weight?: unknown }).weight : null

  if (weight === undefined)
    return 1

  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0)
    throw new KayError('page-settings-invalid', `kay: the \`search\` of ${file} is ${JSON.stringify(value)}, which is no search setting: it takes \`false\` or \`{ weight }\` with a weight of 0 or more`)

  return weight
}

// A page's `revalidate` export in seconds, or undefined when it has none.
function revalidatePeriod(file: string, value: unknown): number | undefined {
  return value === undefined ? undefined : durationSeconds(value, `${file}'s revalidate`)
}

// Whether the file's template, or that of a component it imports, however deep, marks a server island.
export async function reachesServerIsland(file: string, seen = new Set<string>()): Promise<boolean> {
  if (seen.has(file))
    return false

  seen.add(file)

  const source = await Bun.file(file).text()

  if ([...elementsIn(parseKay(source).template)].some(element => serverIslandOf(element, source)))
    return true

  for (const [, specifier] of source.matchAll(KAY_IMPORT)) {
    const imported = resolveFrom(specifier!, file)

    if (imported === undefined)
      continue

    if (await reachesServerIsland(imported, seen))
      return true
  }

  return false
}

function unkeptBy(island: boolean, stamps: boolean, live: boolean): string {
  if (island)
    return 'holds a server island'

  if (live)
    return 'reads a live value, which a server holds'

  return stamps ? 'holds a form stamp or a work challenge, signed per request' : 'reads the site URL, which no config sets'
}

function firstLine(text: string): string {
  const end = text.trim().indexOf('\n')

  return end === -1 ? text.trim() : text.trim().slice(0, end)
}

// What keeps the page from being kept: what its files read, or that it takes params, which `prerender` lists.
// Gives too whether it reads the pathname, which a kept copy is served for only at the path it was rendered at.
async function stopOf(route: Route, scans: Map<string, Promise<Scan>>, root: string): Promise<{ stop?: Stop | undefined, pathname: boolean }> {
  if (route.params.length > 0)
    return { stop: { file: route.file, line: 0, why: 'takes params, so `prerender` lists the pages to render' }, pathname: false }

  return keptScan(route, scans, root)
}

// What a page module says of its own prerendering, read off its source once: the text of its `prerender` and whether it says `keep: true`.
async function pageFlags(file: string): Promise<{ prerender: string | undefined, keep: boolean }> {
  const source = await Bun.file(file).text()
  const settings = analyzeServer(source, parseKay(source).server)?.page?.settings
  const text = (name: string) => {
    const value = settings?.get(name)?.value

    return value === undefined ? undefined : source.slice(value.start, value.end)
  }

  return { prerender: settings?.has('prerender') === true ? text('prerender') ?? '' : undefined, keep: text('keep') === 'true' }
}
