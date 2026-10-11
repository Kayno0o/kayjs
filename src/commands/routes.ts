import type { KayConfig } from '../config'
import type { GuardFile } from '../server/routes'
import type { Command } from './command'
import { relative } from 'node:path'
import process from 'node:process'
import { Elysia } from 'elysia'
import { checkContent } from '../check/project'
import { islandId } from '../compiler'
import { parseKay } from '../compiler/parser'
import { analyzeServer } from '../compiler/script'
import { loadConfig } from '../config'
import { projectPaths } from '../project'
import { actionUrl } from '../runtime/action'
import { CARD_ROUTE, FILES_ROUTE, IMAGE_ROUTE } from '../runtime/image'
import { projectApi } from '../server/api'
import { importModule } from '../server/bundle'
import { buildingWithoutEnv, PUBLIC_ENV_PATH } from '../server/env'
import { ERROR_REPORTS } from '../server/errors'
import { FAVICON_PATHS, faviconSource } from '../server/favicon'
import { HEALTH_PATH } from '../server/lifecycle'
import { registerLoader } from '../server/loader'
import { SERVICE_WORKER } from '../server/offline'
import { OPENAPI_PATH, REFERENCE_PATH } from '../server/openapi'
import { PREVIEW_ROUTE } from '../server/preview'
import { routeMounts, scanEndpoints, scanRoutes } from '../server/routes'
import { ROBOTS, SITEMAP } from '../server/sitemap'
import { CSP_REPORTS } from '../server/violations'
import { projectRoot } from './command'

// One line of the listing, and the chains printed under it.
interface Listed {
  methods: string
  path: string
  kind: 'page' | 'action' | 'endpoint' | 'api' | 'redirect' | 'feed' | 'kay'
  // The file serving it, or what it does when kay serves it.
  by: string
  notes?: string[] | undefined
  layouts?: string[] | undefined
  guards?: string[] | undefined
}

const ROUTE_METHODS = /^(?:get|post|put|patch|delete|head|all)$/i
const SVG_ICON = '/favicon.svg'
const MASKABLE_ICON = /^\/icon-maskable-/

// Every route the project serves, as its server would boot, without running a page or a guard: what a URL that does not match was meant to hit.
export const routes: Command = {
  usage: 'routes [dir]',
  options: {},
  positionals: 1,
  run: async ({ positionals: [path] }) => {
    const root = projectRoot('routes', path)

    if (root === undefined)
      return 1

    // The machine listing them lacks the server's environment, which kay.config.ts and API modules may read.
    buildingWithoutEnv()

    const config = await loadConfig(root)
    const listed = [...await appRoutes(root, config), ...await apiRoutes(root, config), ...redirectRoutes(config), ...await feedRoutes(root, config), ...kayRoutes(root, config)]

    console.log(formatListing(listed))

    return 0
  },
}

async function appRoutes(root: string, config: KayConfig): Promise<Listed[]> {
  const { routes: routesDir } = projectPaths(root, config)
  const mounts = routeMounts(root, config.extensions)
  const [pages, endpoints] = await Promise.all([scanRoutes(routesDir, mounts), scanEndpoints(routesDir, mounts)])
  const listed: Listed[] = []
  const actionFiles = new Set<string>()

  for (const route of pages) {
    const server = await serverOf(route.file)
    const prerender = server?.analysis.page?.settings.get('prerender')
    const prerendered = prerender !== undefined && server!.source.slice(prerender.value.start, prerender.value.end) !== 'false'

    listed.push({ methods: 'GET', path: route.pattern, kind: 'page', by: shown(route.file), notes: [...prerendered ? ['prerendered'] : [], ...guardNotes(route.guards, route.open, config)], layouts: route.layouts.map(shown), guards: route.guards.map(guard => shown(guard.file)) })

    // A layout's actions once, though every page under it renders it.
    for (const file of [...route.layouts, route.file].filter(file => !actionFiles.has(file))) {
      actionFiles.add(file)

      for (const name of (await serverOf(file))?.analysis.actionNames ?? [])
        listed.push({ methods: 'POST', path: actionUrl(islandId(file, root), name), kind: 'action', by: `${shown(file)} ${name}` })
    }
  }

  for (const endpoint of endpoints)
    listed.push({ methods: 'GET', path: endpoint.pattern + (endpoint.suffix ?? ''), kind: 'endpoint', by: shown(endpoint.file), notes: guardNotes(endpoint.guards, endpoint.open, config), guards: endpoint.guards.map(guard => shown(guard.file)) })

  return listed
}

// An API module's routes are only known once it runs: one that cannot load is listed by its mount, with why.
async function apiRoutes(root: string, config: KayConfig): Promise<Listed[]> {
  const modules = await projectApi(root, config)

  if (modules.length > 0)
    await registerLoader(root, config.settings ?? {})

  const listed: Listed[] = []

  for (const module of modules) {
    const guards = module.guards.map(guard => shown(guard.file))
    const notes = guardNotes(module.guards, module.open, config)

    try {
      const instance = (await importModule<{ default?: unknown }>(module.file)).default

      if (!(instance instanceof Elysia))
        throw new Error('it exports no Elysia instance by default')

      for (const route of instance.routes.filter(route => ROUTE_METHODS.test(route.method)))
        listed.push({ methods: route.method.toUpperCase(), path: module.mount + (route.path === '/' ? '' : route.path), kind: 'api', by: shown(module.file), notes, guards })
    }
    catch (error) {
      listed.push({ methods: '?', path: `${module.mount}/*`, kind: 'api', by: shown(module.file), notes: [`not loaded: ${error instanceof Error ? error.message : String(error)}`, ...notes], guards })
    }
  }

  return listed
}

function redirectRoutes(config: KayConfig): Listed[] {
  return Object.entries(config.redirects ?? {}).map(([from, target]) => {
    const { to, permanent = true } = typeof target === 'string' ? { to: target } : target

    return { methods: 'GET', path: from, kind: 'redirect', by: `${permanent ? 308 : 307} to ${to}` }
  })
}

async function feedRoutes(root: string, config: KayConfig): Promise<Listed[]> {
  const { feeds } = await checkContent(root, config.content, config.site !== undefined)

  return feeds.map(feed => ({ methods: 'GET', path: feed.path, kind: 'feed', by: `the collection ${feed.collection}`, notes: feed.localized ? ['under each locale\'s prefix'] : [] }))
}

// What kay serves itself in production, as the config turns each on.
function kayRoutes(root: string, config: KayConfig): Listed[] {
  const kay = (path: string, by: string, methods = 'GET'): Listed => ({ methods, path, kind: 'kay', by })
  const favicon = faviconSource(root, config.favicon, config.manifest)
  const openapi = config.openapi === true ? {} : config.openapi === false ? undefined : config.openapi

  return [
    ...config.health === false ? [] : [kay(config.health?.path ?? HEALTH_PATH, 'health check')],
    ...config.publicEnv ? [kay(PUBLIC_ENV_PATH, 'public environment')] : [],
    kay('/_kay/*', 'build files'),
    kay(IMAGE_ROUTE, 'image variants'),
    kay(CARD_ROUTE, 'share cards'),
    kay(`${FILES_ROUTE}*`, 'stored files'),
    kay(ERROR_REPORTS, 'browser error reports', 'POST'),
    ...typeof config.security === 'object' && config.security.reports === true ? [kay(CSP_REPORTS, 'CSP violation reports', 'POST')] : [],
    ...config.preview ? [kay(PREVIEW_ROUTE, 'preview mode')] : [],
    ...openapi !== undefined && openapi.dev !== true ? [kay(OPENAPI_PATH, 'OpenAPI document'), ...openapi.reference === true ? [kay(REFERENCE_PATH, 'API reference')] : []] : [],
    ...config.site === undefined ? [] : [kay(SITEMAP, 'sitemap, unless the app serves it'), kay(ROBOTS, 'robots.txt, unless the app serves it')],
    ...favicon ? FAVICON_PATHS.filter(path => (path !== SVG_ICON || favicon.svg !== undefined) && (!MASKABLE_ICON.test(path) || favicon.maskable !== undefined)).map(path => kay(path, 'favicon, unless the app serves it')) : [],
    kay(SERVICE_WORKER, 'service worker'),
  ]
}

function guardNotes(guards: GuardFile[] | { file: string }[], open: boolean | undefined, config: KayConfig): string[] {
  if (open)
    return ['open']

  return guards.length === 0 && config.requireGuards ? ['403: no guard under requireGuards'] : []
}

async function serverOf(file: string) {
  if (!file.endsWith('.kay'))
    return undefined

  const source = await Bun.file(file).text()
  const analysis = analyzeServer(source, parseKay(source).server)

  return analysis && { source, analysis }
}

function shown(file: string): string {
  return relative(process.cwd(), file)
}

// Columns padded to their widest; the layouts and guards on lines of their own under the route.
function formatListing(listed: Listed[]): string {
  const width = (key: 'methods' | 'path' | 'kind') => Math.max(...listed.map(entry => entry[key].length))
  const [methods, path, kind] = [width('methods'), width('path'), width('kind')]
  const indent = ' '.repeat(methods + 2)

  return listed.flatMap(entry => [
    `${entry.methods.padEnd(methods)}  ${entry.path.padEnd(path)}  ${entry.kind.padEnd(kind)}  ${[entry.by, ...entry.notes ?? []].join(', ')}`,
    ...(entry.layouts?.length ?? 0) > 0 ? [`${indent}layouts ${entry.layouts!.join(' > ')}`] : [],
    ...(entry.guards?.length ?? 0) > 0 ? [`${indent}guards  ${entry.guards!.join(' > ')}`] : [],
  ]).join('\n')
}
