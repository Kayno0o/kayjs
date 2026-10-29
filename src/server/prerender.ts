import type { OtherPage, RenderedPage } from '../check/seo'
import type { ErrorName, ExportProblem } from '../compiler/errors'
import type { Project } from '../project'
import type { AwaitNote } from '../runtime/html'
import type { ClientBuild, PrerenderedPage } from './client'
import type { LocaleCopy } from './i18n'
import type { ListedParams } from './prerendered'
import type { Scan, Stop } from './pure-page'
import type { Route } from './routes'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { resolveFrom } from '../build/files'
import { elementsIn, serverIslandOf } from '../compiler/ast'
import { exportProblem, KayError } from '../compiler/errors'
import { parseKay } from '../compiler/parser'
import { isAction } from '../runtime/action'
import { durationSeconds } from '../runtime/duration'
import { IMAGE_ROUTE } from '../runtime/image'
import { runInLocale } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { countStandInReads } from '../runtime/site'
import { withPageToken } from '../runtime/uid.server'
import { projectApi } from './api-modules'
import { dropOrphanCopies, keepClasses, missingClasses, PRERENDERED_DIR, readManifest, styleUsesOf, writeManifest } from './client'
import { writeDictionary } from './dictionary'
import { exportedEndpoints } from './endpoints'
import { localeCopies, stateFor } from './i18n'
import { LIVE_MARK, withoutCacheScripts } from './live'
import { pageFlags } from './page-flags'
import { readsOf } from './page-reads'
import { chainSetting, pageSetting } from './page-settings'
import { matchedParams } from './params'
import { listedIn, listedParams, pageEtag, pageToken, pathOf, storedHeaders } from './prerendered'
import { keptScan } from './pure-page'
import { renderPage, renderUnmatched } from './render'
import { judgingReads, RequestReadError, writtenAt } from './request-read'
import { routeChain, scanEndpoints, slashedPath } from './routes'
import { serverIslandModes } from './server-islands'
import { setupPages } from './setup'
import { STAMP_HOLE } from './stamp'

const PARTS = new Intl.ListFormat('en-GB')
const KAY_IMPORT = /\bfrom\s+['"]([^'"]+\.kay)['"]/g
// The pages of a route rendering at once: a render waiting on a database, a CMS or a file lets the next ones run, while each page is still judged and written in turn, as one at a time would. Bounded, so the build holds no more pages than this.
const RENDERS_AT_ONCE = 8
// A page waiting this long on one `await` block is named by the build.
const RUNTIME_FOLDER = `${resolve(import.meta.dir, '..', 'runtime')}/`
const SLOW_AWAIT_MS = 1000

// Whether the renders of the page being judged read the stand-in site, kept per page as several render at once.
const siteReads = new AsyncLocalStorage<{ read: boolean }>()
// What the stand-in site counts its reads in: a read marks the page whose render made it.
const STAND_IN_READS = {
  get reads() {
    return 0
  },
  set reads(_count: number) {
    const page = siteReads.getStore()

    if (page)
      page.read = true
  },
}

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

// A page of a route to prerender: a locale's copy of one listed path.
interface PlannedCopy {
  copy: LocaleCopy
  path: string
  matched: Record<string, unknown>
  weight: () => Promise<number | false>
}

// A copy rendering ahead of its turn to be judged; `first` renders it again as the first render, and `once` as one after it.
interface RenderingCopy {
  token: string
  request: Request
  siteRead: { read: boolean }
  // How many pages had classes kept when it began rendering, which a later one makes stale.
  begun: number
  once: () => Promise<{ response: Response, html: string }>
  first: () => Promise<FirstRender>
  // Thrown once its turn comes, as a route given up on before then leaves it unread.
  rendered: Promise<{ value: FirstRender } | { error: unknown }>
}

interface FirstRender {
  response: Response
  html: string
  // The cache keys and collections it read.
  reads: string[]
  refused: RequestReadError | undefined
  renderedAt: number
  // The `await` blocks the page rendered outside its islands.
  awaits: AwaitNote[]
}

// What a `.kay` file holds that the search for a server island follows: whether its own template marks one, and the `.kay` files it imports.
interface IslandReach {
  island: boolean
  imports: string[]
}

export interface PrerenderOptions {
  // Every page, for `kay build --static`: one without params prerenders unless it opts out, and a page that cannot is reported rather than left to a server.
  exportAll?: boolean
  // Receives every page rendered, for `kay build` to lint their heads.
  rendered?: RenderedPage[] | undefined
  // Receives the pages that answered a status other than 200, which the head lints and the search index leave out, for `kay build` to weigh the scripts they load and to tell what points at them.
  others?: OtherPage[] | undefined
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
  const { source, mounts, routes, matchers, i18n, locales, site, renderOptions } = await setupPages(project, () => client, true)

  options.routes?.push(...routes)
  countStandInReads(STAND_IN_READS)

  const pages: Record<string, PrerenderedPage> = {}
  const paths = new Map<string, string>()
  // The tokens the pages so far draw their ids from.
  const tokens = new Set<string>()
  // The files of pages kept without being asked for, which a page that was asked for takes the place of.
  const kept = new Set<string>()
  // How many times a page showed a class its head had no rule for, which the manifest then keeps.
  let restyles = 0
  // What each file read, for the next route to reach it again.
  const scans = new Map<string, Promise<Scan>>()
  // What each `.kay` file holds of server islands, for the next route to reach it again.
  const reach = new Map<string, Promise<IslandReach>>()

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

    // Every page of the route in order, one per locale of each listed path, up to params its matchers refuse, which fail the route once the pages before them are judged.
    const planned: (PlannedCopy | { error: unknown })[] = []

    for (const params of await listedParams(route, file, 'prerender', listed, i18n?.settings)) {
      try {
        const path = pathOf(route, params)
        const matched = matchedParams(route, params, matchers)

        if (!matched)
          throw new KayError('export-needs-params', `kay: ${file} lists ${JSON.stringify(params)} in prerender, which its matchers refuse, so no request would reach it`)

        // The weight of the page's words, worked out once for the locales it is served in.
        let weighed: Promise<number | false> | undefined
        const weight = async () => weighed ??= searchWeight(chainSetting(chain, 'search'), params, file)

        for (const copy of localeCopies(i18n?.settings, path).filter(copy => listedIn(params, copy.locale, i18n?.settings)))
          planned.push({ copy, path, matched, weight })
      }
      catch (error) {
        planned.push({ error })

        break
      }
    }

    // The copy being judged, and those rendering ahead of it by index, which leave `started` as their turn comes.
    let at = 0
    const started = new Map<number, RenderingCopy>()
    // A page kept without being asked for is skipped at the first render showing it is not, so none renders ahead of it to be thrown away.
    const ahead = auto ? 1 : RENDERS_AT_ONCE

    const start = (index: number): RenderingCopy => {
      const { copy, path, matched } = planned[index] as PlannedCopy
      // Rendered at the path the server answers it at, which `trailingSlash` spells.
      const served = slashedPath(copy.path, config.trailingSlash)
      const request = new Request(`${copy.host === undefined ? 'http://localhost' : `https://${copy.host}`}${served}`)
      // onError is the app's for requests it answers; the build logs what a prerendered page throws, and takes a read of the request for its own to judge.
      const refusal: { read?: RequestReadError } = {}
      // Guards run when the page is served, for whoever asks; the build renders what they let through.
      const render = async (awaits?: AwaitNote[]) => renderPage({ ...route, guards: [] }, { request }, matched, client, { ...renderOptions, onError: judged(refusal), prerendering: true, awaits, guarded: guardedPage(route, config.requireGuards) })
      const inLocale = async (awaits?: AwaitNote[]) => runInLocale(stateFor(locales, copy.locale ?? locales.settings.defaultLocale, path, request), async () => render(awaits))
      // The ids a page draws keep apart from those of the page it is swapped for, so each page has a token of its own, the same on every render and build; the body is read within it, as a stream draws its ids as it is read.
      // Taken in the order the pages are judged in, as rendering one at a time took them.
      const token = pageToken(copy.key, tokens)

      tokens.add(token)
      const read = async (awaits?: AwaitNote[]) => {
        const rendered = await inLocale(awaits)

        return { response: rendered, html: await rendered.text() }
      }
      const siteRead = { read: false }
      const once = async (awaits?: AwaitNote[]) => siteReads.run(siteRead, async () => withPageToken(token, async () => read(awaits)))
      const first = async () => {
        delete refusal.read
        siteRead.read = false
        // Taken before the render, so a date passing during it counts as passed since.
        const renderedAt = Date.now()
        const awaits: AwaitNote[] = []
        const { result, reads } = await readsOf(async () => once(awaits))

        return { ...result, reads, refused: refusal.read, renderedAt, awaits }
      }

      return { token, request, siteRead, begun: restyles, once, first, rendered: settled(first()) }
    }

    try {
      for (; at < planned.length; at++) {
        for (let next = at; next < Math.min(at + ahead, planned.length) && !('error' in planned[next]!); next++) {
          if (started.has(next))
            continue

          // A page whose request cannot be made fails the route at its turn, as it did rendering one at a time.
          try {
            started.set(next, start(next))
          }
          catch (error) {
            planned[next] = { error }

            break
          }
        }

        const planning = planned[at]!

        if ('error' in planning)
          throw planning.error

        const { copy, weight } = planning
        const { token, request, siteRead, begun, once, first, rendered: outcome } = started.get(at)!

        started.delete(at)

        const ended = await outcome
        // A page that began rendering before an earlier one had classes kept renders again, with the head that keeping gave the route, whether or not it threw.
        const stale = begun !== restyles

        if (!stale && 'error' in ended)
          throw ended.error

        const rendered = !stale && 'value' in ended ? ended.value : await first()

        let { response, html } = rendered
        const { reads: dataRead, refused, renderedAt, awaits } = rendered

        if (refused !== undefined) {
          const readAt = `reads \`${refused.read}\`${refused.file === undefined ? '' : ` at ${relative(root, refused.file)}:${refused.line}`}`

          // A page the build took up on its own, or for a server island it holds, is rendered per request when it needs one.
          if (auto || (marked && prerender === undefined && !options.exportAll))
            return skip(`${readAt}, which only a request holds`)

          const inLayout = refused.file !== undefined && route.layouts.includes(refused.file)
          const instead = inLayout
            ? 'every page under that layout renders it, so read it in the pages that are not prerendered, or drop `prerender` from this one'
            : 'drop `prerender` from `export const page` to render it per request'
          const advice = options.exportAll ? 'a static export renders every page at build time, so the read has to go, or the site needs a server' : instead

          throw new KayError('export-server-render', `kay: prerendering ${copy.path} from ${file} failed: it ${readAt}, which only a request holds, and a prerendered page renders once, at build time; ${advice}`)
        }

        // What the page shows that its source does not spell out, a class built from data, is kept in its head: the rules come from the page as it rendered.
        const shown = missingClasses(client, routeChain(route).files, html)

        if (shown.length > 0) {
          await keepClasses(client, routeChain(route).files, shown)
          restyles++
          ;({ response, html } = await once())
        }

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
        const readsSite = siteRead.read
        const livesOn = html.includes(LIVE_MARK)

        if (auto && (islands.length > 0 || stamps || readsSite || livesOn))
          return skip(unkeptBy(islands.length > 0, stamps, livesOn))

        // A page holding a server island may read cached values with `live: true`: what the island's own request reads is what it follows, and the page, built once, follows nothing.
        const unfollowed = livesOn && islands.length > 0 ? withoutCacheScripts(html) : undefined

        if (livesOn && unfollowed === undefined)
          throw new KayError('export-server-render', 'kay: it reads a live value, which only a server holds and signs the connection to per request; drop `prerender` from `export const page`, or read the value in a component the page does not render at build time')

        if (unfollowed !== undefined)
          html = unfollowed.html

        if (options.exportAll && readsSite)
          throw new KayError('export-site-url', 'kay: it reads the site, through siteUrl() or siteOrigin(), which neither `site` in kay.config.ts nor SITE_URL sets')

        if (options.exportAll && islands.length > 0)
          throw new KayError('export-server-render', `kay: it holds ${islands.length === 1 ? 'a server island' : `${islands.length} server islands`}, which only a server renders per request`)

        if (options.exportAll && stamps)
          throw new KayError('export-server-render', 'kay: a form in it posts to an action with `minTime` or `proofOfWork`, or holds a `workChallenge`, whose stamp or challenge only a server signs per request')

        if (islands.includes('defer') && client.entry === undefined)
          throw new KayError('export-server-render', `kay: it defers a server island, which kay's browser entry fetches, and with no island and \`navigation: false\` the build has none; mark it \`server\` to render it inline instead`)

        if (unfollowed !== undefined)
          kayLog('warn', `${copy.path} reads ${unfollowed.keys.slice(0, 5).map(key => `'${key}'`).join(', ')}${unfollowed.keys.length > 5 ? ' and more' : ''} with \`live: true\` in its own render, which the build runs once: what the page shows of it itself goes stale and only its server islands follow, so drop \`prerender\` from \`export const page\` if the page shows it`)

        for (const message of awaitWarnings(copy.path, awaits, root))
          kayLog('warn', message)

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

          const sitemap = pageSetting(module, 'sitemap')

          options.rendered?.push({ path: copy.path, file: route.file, locale: copy.locale, host: copy.host, html, noindex, sitemap: sitemap !== undefined, search: indexed ? await weight() : false, listed: !noindex && sitemap !== false && (sitemap !== undefined || route.guards.length === 0), guarded: route.guards.length > 0 })
        }
        else if (!auto) {
          options.others?.push({ file: route.file, html, path: copy.path, host: copy.host, status: response.status, location: response.headers.get('location') ?? undefined })
        }

        const stored: PrerenderedPage = { pattern: route.pattern, locale: copy.locale ?? locales.settings.defaultLocale, file: name, status: response.status, headers: storedHeaders(response.headers), etag: pageEtag(html), renderedAt, revalidate, ...islands.length > 0 ? { islands } : {}, ...stamps ? { stamps } : {}, ...readsSite ? { readsSite } : {}, ...auto ? { kept: true } : {}, ...auto && readsPathname ? { pathname: new URL(request.url).pathname } : {}, ...dataRead.length > 0 ? { reads: dataRead } : {}, ...token === pageToken(copy.key) ? {} : { token } }

        pending.push(() => {
          pages[copy.key] = stored
        })
      }
    }
    finally {
      // A route given up on leaves the tokens of the pages rendering ahead free, as one rendering a page at a time never took them, and none of them running.
      for (const { token } of started.values())
        tokens.delete(token)

      await Promise.all([...started.values()].map(async ({ rendered }) => rendered))
    }

    return pending
  }

  // The page a path no route serves is answered with, in the default locale, as every other prerendered page is drawn; none when it fails to render, which a visit to it would report.
  const renderedMissing = async (): Promise<string> => {
    const request = new Request('http://localhost/_kay-dictionary')
    const token = pageToken('/_kay-dictionary', tokens)
    const render = async () => withPageToken(token, async () => {
      const response = await renderUnmatched(await source.fallback(project, mounts), { request }, client, { ...renderOptions, onError: judged({}), prerendering: true })

      return response.status === 404 && response.headers.get('content-type')?.startsWith('text/html') === true ? response.text() : ''
    })

    try {
      return await runInLocale(stateFor(locales, locales.settings.defaultLocale, '/', request), render)
    }
    catch {
      return ''
    }
  }

  // What keeps a page from a static export, each named, so one build reports them all.
  const problems: ExportProblem[] = []

  for (const [index, route] of routes.entries()) {
    options.onRoute?.(index, routes.length)

    // Read off the source first: a page that prerenders nothing, and is not shown to read nothing, is never imported, nor anything it imports.
    const marked = route.params.length === 0 && await reachesServerIsland(route.file, reach)

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

  if (restyles > 0)
    await dropOrphanCopies(client, dir, pages)

  // A static host cannot answer by what the browser holds, so only a server build has a dictionary, and one with a prerendered page, whose layouts the build renders already.
  const dictionary = options.exportAll || config.compressionDictionary === false || Object.keys(pages).length === 0 ? undefined : await writeDictionary(client.dir, await renderedMissing())

  await writeManifest(root, { ...manifest, pages, site, ...dictionary ? { dictionary } : {}, ...restyles > 0 && client.styleUses ? { styleUses: styleUsesOf(root, client.styleUses) } : {} }, output)
  client.pages = new Map(Object.entries(pages))
  client.dictionary = dictionary

  return Object.keys(pages).length
}

// Whether a guard answers for the page, `requireGuards` refusing one no guard covers: its words stay out of the public search index.
// A page's `await` blocks resolve at build: a pending branch no visitor sees, and a slow value the build waits for.
function awaitWarnings(path: string, awaits: AwaitNote[], root: string): string[] {
  const warnings: string[] = []
  const placed = (note: AwaitNote) => {
    const at = writtenAt(note.stack, [RUNTIME_FOLDER])

    return at === undefined ? 'a component' : `${relative(root, at.file)}:${at.line}`
  }

  for (const note of awaits.filter(({ pending }) => pending))
    warnings.push(`${path} renders an \`await\` block with a pending branch at ${placed(note)}: the build resolves it, so its pending content never shows; wrap it in a client island, or in a deferred server island (\`server="defer"\`), to show it to a visitor`)

  for (const note of awaits) {
    const waited = (note.settled ?? note.started) - note.started

    if (waited >= SLOW_AWAIT_MS)
      warnings.push(`${path} waited ${(waited / 1000).toFixed(1)}s on an \`await\` block at ${placed(note)}, which the build resolves: the wait is spent on every build; move it to a client island or a deferred server island, or make its value faster`)
  }

  return warnings
}

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

// Whether the file's template, or that of a component it imports, however deep, marks a server island; `reach` keeps what each file holds, read and parsed once for every route of a build.
export async function reachesServerIsland(file: string, reach = new Map<string, Promise<IslandReach>>(), seen = new Set<string>()): Promise<boolean> {
  if (seen.has(file))
    return false

  seen.add(file)

  let held = reach.get(file)

  if (held === undefined)
    reach.set(file, held = islandReach(file))

  const { island, imports } = await held

  if (island)
    return true

  for (const imported of imports) {
    if (await reachesServerIsland(imported, reach, seen))
      return true
  }

  return false
}

async function settled<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  try {
    return { value: await promise }
  }
  catch (error) {
    return { error }
  }
}

async function islandReach(file: string): Promise<IslandReach> {
  const source = await Bun.file(file).text()

  if ([...elementsIn(parseKay(source).template)].some(element => serverIslandOf(element, source)))
    return { island: true, imports: [] }

  return { island: false, imports: [...source.matchAll(KAY_IMPORT)].flatMap(([, specifier]) => resolveFrom(specifier!, file) ?? []) }
}

function unkeptBy(island: boolean, stamps: boolean, live: boolean): string {
  if (island)
    return 'holds a server island'

  if (live)
    return 'reads a live value, which a server holds'

  return stamps ? 'holds a form stamp or a work challenge, signed per request' : 'reads the site URL, which no config sets'
}

// An `onError` for a render at build time that keeps the first read of a request it meets in `refusal`.
function judged(refusal: { read?: RequestReadError }): (event: { error: unknown }) => void {
  const handler = ({ error }: { error: unknown }) => {
    if (error instanceof RequestReadError)
      refusal.read ??= error
  }

  judgingReads.add(handler)

  return handler
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
