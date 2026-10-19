import type { CheckDiagnostic, CheckOptions } from '.'
import type { CollectionFeed } from '../content/claims'
import type { LocaleSettings } from '../runtime/i18n'
import type { ServedProject } from './shadow-types'
import { join, resolve } from 'node:path'
import { checkBudget } from '../build/budget'
import { islandId } from '../compiler'
import { CONFIG_FILE } from '../config'
import { claimFeed } from '../content/claims'
import { projectPaths } from '../project'
import { actionUrl } from '../runtime/action'
import { actionClash } from '../server/action-clash'
import { mcpPath, RESOURCE_METADATA } from '../server/api-modules'
import { basePath } from '../server/base'
import { checkRequestIdHeader, healthTimeoutMs, liveLimits, remoteLimits, shutdownSeconds } from '../server/config-limits'
import { claimEndpoints } from '../server/endpoint-claims'
import { PUBLIC_ENV_PATH } from '../server/env-state'
import { faviconSource, svgFaviconProblems } from '../server/favicon'
import { localeSettings, refuseLocaleClashes } from '../server/i18n'
import { claimPublic, publicFiles } from '../server/public'
import { claimRedirects, readRedirects } from '../server/redirects'
import { refuseClashes } from '../server/route-table'
import { routeMounts, scanEndpoints, scanRoutes } from '../server/routes'
import { siteOrigin } from '../server/seo'
import { ServedPaths } from '../server/served-paths'
import { serverFacts } from './layout-facts'
import { pageHeadLints } from './page-heads'
import { queryClashes } from './queries'

// What the server refuses when it boots, found by the functions it calls then, so `kay check` and the boot cannot disagree; the collections' feeds come from the process that read them.
// A `scanned` project, the run's own, spares scanning its routes, public files and endpoints again.
export async function bootProblems(root: string, options: CheckOptions, feeds: CollectionFeed[] = [], scanned?: ServedProject): Promise<CheckDiagnostic[]> {
  const diagnostics: CheckDiagnostic[] = []
  const config = join(root, CONFIG_FILE)
  const { routes: routesDir, public: publicDir } = projectPaths(root, options)
  const [routes, files] = scanned ? [scanned.routes, scanned.found] : await Promise.all([scanRoutes(routesDir, routeMounts(root, options.extensions)), publicFiles(publicDir)])

  const refused = (file: string, run: () => void) => {
    try {
      run()
    }
    catch (error) {
      for (const each of error instanceof AggregateError ? error.errors : [error])
        diagnostics.push({ file, line: 1, column: 1, message: each instanceof Error ? each.message : String(each) })
    }
  }

  const { base, site, shutdownTimeout, budget } = options

  refused(config, () => basePath(base))

  if (site !== undefined)
    refused(config, () => siteOrigin(site))

  if (shutdownTimeout !== undefined)
    refused(config, () => shutdownSeconds(shutdownTimeout))

  const { health } = options

  if (health !== undefined && health !== false)
    refused(config, () => healthTimeoutMs(health))

  refused(config, () => liveLimits(options.live))
  refused(config, () => remoteLimits(options.images))
  refused(config, () => checkRequestIdHeader(options.requestIdHeader))

  refused(config, () => checkBudget(budget))

  // An SVG favicon is drawn by `kay build`, which it would fail.
  for (const problem of await svgFaviconProblems(faviconSource(root, options.favicon, options.manifest)))
    diagnostics.push({ line: 1, column: 1, ...problem })

  // So is the share cards' logo, which the boot draws and refuses.
  const logo = options.images?.card?.logo

  if (logo !== undefined) {
    // Loaded here alone: drawing the logo takes the image server, which no other check needs.
    const { cardLogoProblems } = await import('../server/card')

    for (const problem of await cardLogoProblems(resolve(root, logo)))
      diagnostics.push({ line: 1, column: 1, ...problem })
  }

  let settings: LocaleSettings | undefined

  // Settings the server would refuse are reported with the shadow types already.
  try {
    settings = options.i18n && localeSettings(options.i18n)
  }
  catch {}

  if (settings)
    refused(config, () => refuseLocaleClashes(settings, routes))

  // Claimed in the order the server claims them.
  const served = new ServedPaths()

  refused(routesDir, () => refuseClashes(routesDir, routes, served, settings))

  if (options.publicEnv)
    served.claim({ path: PUBLIC_ENV_PATH, owner: '`publicEnv`', kind: 'kay' })

  refused(publicDir, () => claimPublic(served, files))

  try {
    if (scanned?.endpointFailure !== undefined)
      throw scanned.endpointFailure

    claimEndpoints(served, scanned?.endpoints ?? await scanEndpoints(routesDir, routeMounts(root, options.extensions)), root)
  }
  catch (error) {
    diagnostics.push({ file: routesDir, line: 1, column: 1, message: error instanceof Error ? error.message : String(error) })
  }

  refused(config, () => claimRedirects(served, readRedirects(options.redirects ?? {})))

  let mcpAt: string | undefined

  refused(config, () => {
    mcpAt = mcpPath(options.mcp)
  })

  if (mcpAt !== undefined) {
    const endpoint: string = mcpAt

    refused(config, () => served.claim({ path: endpoint, owner: '`mcp`', kind: 'kay', method: 'ALL' }))

    for (const path of [RESOURCE_METADATA, `${RESOURCE_METADATA}${endpoint}`])
      served.offer({ path, owner: '`mcp`', kind: 'kay', method: 'ALL' })
  }

  // API modules' routes are left to the boot, which `kay build` runs: listing them takes running the modules, which may need what only the server has.
  for (const feed of feeds)
    refused(projectPaths(root, options).content, () => claimFeed(served, feed, settings))

  diagnostics.push(...await actionClashes(root, [...new Set(routes.flatMap(route => [...route.layouts, ...route.actionModules ?? [], route.file]))]))

  diagnostics.push(...await queryClashes(routes))

  diagnostics.push(...await pageHeadLints(options, routes, routesDir, publicDir))

  return diagnostics
}

// The URL each action of the pages and layouts is served at, as the server registers it, reported where a second file takes one.
// Only an export declared as an `action(...)` call counts: the server registers actions only, so another export two such files share clashes nowhere.
export async function actionClashes(root: string, files: string[]): Promise<CheckDiagnostic[]> {
  const diagnostics: CheckDiagnostic[] = []
  const served = new Map<string, string>()

  for (const file of files) {
    const source = await Bun.file(file).text()

    for (const name of serverFacts(file, source).server?.actionNames ?? []) {
      const url = actionUrl(islandId(file, root), name)
      const taken = served.get(url)

      if (taken === undefined)
        served.set(url, file)
      else if (taken !== file)
        diagnostics.push({ file, line: 1, column: 1, message: actionClash(taken, file, url).message })
    }
  }

  return diagnostics
}
