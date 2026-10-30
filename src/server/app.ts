import type { InternalConfig, KayConfig } from '../config'
import type { Project } from '../project'
import type { ClientBuild } from './client'
import type { ServedRoute } from './guards'
import type { ClaimedFile } from './public'
import type { Redirect } from './redirects'
import type { RouteTable } from './route-table'
import type { Route } from './routes'
import type { Scanned } from './setup'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { KayError } from '../compiler/errors'
import { refuseFeedsWithoutSite } from '../content/server'
import { mcpPath, mcpRateLimit } from './api-modules'
import { actionOptionsOf, apiDocuments, appRoutes, bootOf, bootWarnings, buildFiles, compressAnswers, files, identifyRequests, kayEndpoints, keptPageWrites, knowPages, lateApp, limitBodiesAndClaimApi, logAnswers, pageRoutes, reports, rewriteAnswers, serveDevRoutes, serverMode, siteFiles, stopOnSignals, trustRequests, useExtensions } from './app-stages'
import { bundled } from './bundle'
import { checkRequestIdHeader, checkTimeZone, healthTimeoutMs } from './config-limits'
import { corsRule } from './cors'
import { claimEndpoints } from './endpoint-claims'
import { holdPublicEnv } from './env'
import { PUBLIC_ENV_PATH, publicEnvFiles, publicInFenceMessage } from './env-state'
import { faviconSource, MANIFEST, manifestJson } from './favicon'
import { loadGuards } from './guards'
import { refuseLocaleClashes } from './i18n'
import { dropExitListenerOnStop } from './lifecycle'
import { mcpKeySetting, resolveMcpKey } from './mcp-key'
import { checkProxy } from './protection'
import { claimPublic } from './public'
import { claimRedirects, readRedirects } from './redirects'
import { routeTable } from './route-table'
import { ServedPaths } from './served-paths'
import { setupPages } from './setup'
import { projectSource } from './source'

// Options given here win over the project's `kay.config.ts`.
export interface PagesOptions extends KayConfig {
  // Project root: island ids and `.kay/` output are relative to it. Defaults to the working directory.
  root?: string | undefined
  // Shows thrown errors with their stack. Defaults to on when NODE_ENV is development.
  dev?: boolean | undefined
  // Serves the bundle `kay build` wrote instead of bundling at boot. Defaults to on when NODE_ENV is production.
  prebuilt?: boolean | undefined
}

// The options once the project is loaded: what the caller gave and what kay added, `publicEnv` among it.
export type ServedOptions = PagesOptions & InternalConfig

// The routes with their guards loaded.
async function servedRoutes(routes: Route[], pages: ServedRoute[], required: boolean | undefined): Promise<ServedRoute[]> {
  return Promise.all(pages.map(async (page, index) => Object.assign(page, await loadGuards(routes[index]!, required))))
}

// What the server's options refuse by themselves, before the project is read.
function refuseOptions(options: PagesOptions): void {
  if (options.health !== false)
    healthTimeoutMs(options.health)

  checkRequestIdHeader(options.requestIdHeader)
  checkTimeZone(options.timeZone)
  checkProxy(options.proxy)

  if (options.cors)
    corsRule(options.cors)
}

// What the boot claimed before any client build, which the rest of it goes on from.
interface Claimed {
  served: ServedPaths
  // The routes with their guards not loaded yet, which `servedRoutes` fills in place so the table keeps holding them.
  routes: ServedRoute[]
  table: RouteTable
  publicServed: ClaimedFile[]
  redirects: Redirect[]
  mcpAt: string | undefined
}

// What the server refuses once the routes, public files, endpoints and collections are read, which is all of it that needs no build, so a refused config starts none.
// Claims run in the order the server makes them, which `kay check` keeps in `src/check/boot.ts` too; what the boot claims later (extensions' and API modules' routes, the favicon) is still refused after the build starts, as it needs them loaded.
function refuseScanned({ root, config }: Project<ServedOptions>, { routes, files, endpoints, collections, i18n, site, base }: Scanned): Claimed {
  if (i18n)
    refuseLocaleClashes(i18n, routes)

  const served = new ServedPaths()
  const pages: ServedRoute[] = routes.map(route => ({ ...route, guards: [] }))
  const table = routeTable(pages, i18n, served)

  if (config.publicEnv)
    served.claim({ path: PUBLIC_ENV_PATH, owner: '`s.Public`', kind: 'kay', exported: true })

  const publicServed = claimPublic(served, files)

  claimEndpoints(served, endpoints, root)

  const redirects = readRedirects(config.redirects ?? {})

  claimRedirects(served, redirects)

  const mcpAt = mcpPath(config.mcp)

  // Refused here with the other settings, not when the endpoint is first mounted.
  mcpRateLimit(config.mcp)

  if (mcpAt !== undefined)
    served.claim({ path: mcpAt, owner: '`mcp`', kind: 'kay', method: 'ALL' })

  refuseFeedsWithoutSite(collections, site)

  // A manifest something else serves is not made, so its settings are not checked either.
  if (!served.heldByApp(MANIFEST) && faviconSource(root, config.favicon, config.manifest) !== undefined)
    manifestJson(undefined, undefined, config.manifest, base)

  return { served, routes: pages, table, publicServed, redirects, mcpAt }
}

// The Elysia app behind `pages()`, serving whatever browser build `loadClient` provides.
export async function servePages(project: Project<ServedOptions>, loadClient: () => ClientBuild | Promise<ClientBuild>, skipBroken = false) {
  return (await pagesApp(project, loadClient, false, skipBroken)).app
}

// The modules declaring an `s.Public` field run before any build starts, so a name meant for the server alone is refused first and the values are there before a page or the browser reads them. Returns their paths.
async function loadPublicModules(root: string): Promise<string[]> {
  const held = bundled()

  // An executable holds the modules the build found, already run by its entry, with no `src` to scan.
  if (held?.publicModules !== undefined) {
    holdPublicEnv(held.publicModules)

    return held.publicModules
  }

  const files = publicEnvFiles(root)
  const inFence = files.find(file => file.endsWith('.kay'))

  if (inFence !== undefined)
    throw new KayError('config-invalid', publicInFenceMessage(inFence))

  const paths = files.map(file => join(root, file))

  await Promise.all(paths.map(async (path): Promise<void> => void await import(path)))
  holdPublicEnv(paths)

  return paths
}

// The app, with every path it serves, each claimed as its feature registers it; `exported` when `kay build --static` reads the site from it, its check having reported a missing site.
// Each stage registers its hooks and routes in turn, and the order is behaviour: `onRequest` hooks run in it, and a route runs only the other hooks registered before it. `tests/app-hooks.test.ts` pins it.
export async function pagesApp(project: Project<ServedOptions>, loadClient: () => ClientBuild | Promise<ClientBuild>, exported = false, skipBroken = false) {
  const { root, config: options, mode } = project
  const late = lateApp()

  refuseOptions(options)

  const running = serverMode(mode, exported)
  // Before anything is built, so a production server without the key it asks for stops at once; a static export serves no endpoint.
  const keySetting = exported ? undefined : mcpKeySetting(options.mcp)
  const mcpKey = keySetting === undefined ? undefined : resolveMcpKey(keySetting, { root: projectSource().runtimeRoot(root), production: !running.dev && running.production }) ?? false

  const publicModules = options.publicEnv ? await loadPublicModules(root) : []
  const setup = await setupPages(project, loadClient, false, late.spell, scanned => refuseScanned(project, scanned), exported)
  const { served, table, publicServed, redirects, mcpAt } = setup.claimed
  const routes = await servedRoutes(setup.routes, setup.claimed.routes, options.requireGuards)
  const app = new Elysia({ name: 'kay/pages', seed: root })

  dropExitListenerOnStop(app)

  const boot = bootOf({ app, env: { ...running, base: setup.base, trailingSlash: options.trailingSlash }, project, setup, served, routes, table, late, mcpAt, mcpKey })
  const earlier = knowPages(boot)
  const writes = keptPageWrites(boot)

  trustRequests(boot)
  const redirector = compressAnswers(boot)

  logAnswers(boot)
  const apiMountsServed = rewriteAnswers(boot)

  identifyRequests(boot)
  const jobsPage = kayEndpoints(boot, publicModules)

  if (boot.env.devRoutes)
    await serveDevRoutes(boot)
  else
    stopOnSignals(boot)

  const servers = await useExtensions(boot)

  await buildFiles(boot, earlier)

  const actionOptions = actionOptionsOf(boot, skipBroken)
  const appServed = await appRoutes(boot, actionOptions, jobsPage, apiMountsServed)

  await apiDocuments(boot, appServed, actionOptions, limitBodiesAndClaimApi(boot, appServed, servers))
  reports(boot)
  await files(boot, actionOptions)
  bootWarnings(boot)

  const prerendered = await siteFiles(boot)

  await pageRoutes(boot, { redirects, publicServed, redirector, prerendered, writes })

  return { app, served, locale: setup.locales.settings.defaultLocale, securityOptions: boot.securityOptions, routes }
}
