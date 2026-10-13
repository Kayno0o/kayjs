import type { KayConfig } from '../config'
import type { LocaleSettings } from '../runtime/i18n'
import type { GuardFile, Route } from '../server/routes'
import type { Command } from './command'
import { Console } from 'node:console'
import { existsSync } from 'node:fs'
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
import { localeCopies, localeSettings, routedSettings } from '../server/i18n'
import { HEALTH_PATH } from '../server/lifecycle'
import { registerLoader } from '../server/loader'
import { SERVICE_WORKER } from '../server/offline'
import { OPENAPI_PATH, REFERENCE_PATH } from '../server/openapi'
import { reachesServerIsland } from '../server/prerender'
import { PREVIEW_ROUTE } from '../server/preview'
import { apiRoutePath, endpointPath, ROUTE_METHODS, routeMounts, scanEndpoints, scanRoutes } from '../server/routes'
import { ROBOTS, SITEMAP } from '../server/sitemap'
import { CSP_REPORTS } from '../server/violations'
import { projectRoot } from './command'

// One line of the listing, and the chains printed under it.
interface Listed {
  methods: string
  path: string
  kind: 'page' | 'action' | 'endpoint' | 'api' | 'plugin' | 'redirect' | 'feed' | 'kay'
  // The file serving it, or what it does when kay serves it.
  by: string
  notes?: string[] | undefined
  layouts?: string[] | undefined
  guards?: string[] | undefined
}

const PARAM = /:([^/?]+)/g
// What the console writes to stdout, where the listing goes.
const STDOUT_METHODS = ['log', 'info', 'debug', 'dir', 'dirxml', 'table', 'group', 'groupCollapsed', 'groupEnd', 'count', 'countReset', 'time', 'timeEnd', 'timeLog']
const SVG_ICON = '/favicon.svg'
const MASKABLE_ICON = /^\/icon-maskable-/

// Every route the project serves, as its server would boot, without running a page or a guard: what a URL that does not match was meant to hit. API modules run as they are imported, as the server imports them.
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
    const listed = [...await appRoutes(root, config), ...await apiRoutes(root, config), ...pluginRoutes(config), ...redirectRoutes(config), ...await feedRoutes(root, config), ...kayRoutes(root, config)]
    const unlisted = unlistedServers(root, config)

    console.log(formatListing(listed) + (unlisted.length === 0 ? '' : `\n\nNot listed: the routes ${unlisted.join(' and ')} ${unlisted.length === 1 ? 'adds' : 'add'} when the server starts.`))

    return 0
  },
}

async function appRoutes(root: string, config: KayConfig): Promise<Listed[]> {
  const { routes: routesDir } = projectPaths(root, config)
  const mounts = routeMounts(root, config.extensions)
  const [pages, endpoints] = await Promise.all([scanRoutes(routesDir, mounts), scanEndpoints(routesDir, mounts)])
  const listed: Listed[] = []
  const actionFiles = new Set<string>()
  const settings = config.i18n && routedSettings(localeSettings(config.i18n), pages)

  for (const route of pages) {
    const prerendered = await prerenderNote(route)
    const guards = guardNotes(route.guards, route.open, config)

    // Each locale's copy, the layouts and guards under the first alone, as every copy shares them.
    for (const [index, copy] of localeCopies(settings, route.pattern).entries())
      listed.push({ methods: 'GET', path: withMatchers(copy.path, route), kind: 'page', by: shown(route.file), notes: [...localeNotes(copy, settings), ...prerendered, ...guards], ...index === 0 && { layouts: route.layouts.map(shown), guards: route.guards.map(guard => shown(guard.file)) } })

    // A layout's actions once, though every page under it renders it.
    for (const file of [...route.layouts, route.file].filter(file => !actionFiles.has(file))) {
      actionFiles.add(file)

      for (const name of (await serverOf(file))?.analysis.actionNames ?? [])
        listed.push({ methods: 'POST', path: actionUrl(islandId(file, root), name), kind: 'action', by: `${shown(file)} ${name}` })
    }
  }

  for (const endpoint of endpoints)
    listed.push({ methods: 'GET', path: endpointPath(endpoint), kind: 'endpoint', by: shown(endpoint.file), notes: guardNotes(endpoint.guards, endpoint.open, config), guards: endpoint.guards.map(guard => shown(guard.file)) })

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
    // A library's module asks no guard of the app, but runs those of its own directory.
    const notes = guardNotes(module.guards, module.open === true && module.guards.length === 0, config)

    try {
      const instance = (await importApi(module.file)).default

      if (!(instance instanceof Elysia))
        throw new Error('it exports no Elysia instance by default')

      for (const route of instance.routes.filter(route => ROUTE_METHODS.test(route.method)))
        listed.push({ methods: route.method.toUpperCase(), path: apiRoutePath(module.mount, route.path), kind: 'api', by: shown(module.file), notes, guards })
    }
    catch (error) {
      listed.push({ methods: '?', path: `${module.mount}/*`, kind: 'api', by: shown(module.file), notes: [`not loaded: ${error instanceof Error ? error.message : String(error)}`, ...notes], guards })
    }
  }

  return listed
}

// An API module runs as it is imported: what it writes to stdout goes to stderr, off the listing, and its `process.exit()` fails it alone.
async function importApi(file: string): Promise<{ default?: unknown }> {
  const toStderr = new Console({ stdout: process.stderr, stderr: process.stderr })
  const saved = STDOUT_METHODS.map(name => [name, Reflect.get(console, name)] as const)
  const write: unknown = Reflect.get(process.stdout, 'write')
  const exit: unknown = Reflect.get(process, 'exit')

  for (const name of STDOUT_METHODS)
    Reflect.set(console, name, (Reflect.get(toStderr, name) as (...args: unknown[]) => void).bind(toStderr))

  Reflect.set(process.stdout, 'write', process.stderr.write.bind(process.stderr))
  process.exit = (code?: number) => {
    throw new Error(`it calls process.exit(${code ?? ''})`)
  }

  try {
    return await importModule<{ default?: unknown }>(file)
  }
  finally {
    for (const [name, method] of saved)
      Reflect.set(console, name, method)

    Reflect.set(process.stdout, 'write', write)
    Reflect.set(process, 'exit', exit)
  }
}

// The routes of the server plugins extensions give as an Elysia instance; one given as a function is built only as the server starts.
function pluginRoutes(config: KayConfig): Listed[] {
  return (config.extensions ?? []).flatMap(({ name, server }) => server instanceof Elysia ? server.routes.filter(route => ROUTE_METHODS.test(route.method)).map(route => ({ methods: route.method.toUpperCase(), path: route.path, kind: 'plugin' as const, by: `the extension ${name}` })) : [])
}

// What adds routes no file or setting tells of: the server entry, and the extensions' server plugins given as a function.
function unlistedServers(root: string, config: KayConfig): string[] {
  const entry = projectPaths(root, config).entry
  const built = (config.extensions ?? []).filter(({ server }) => typeof server === 'function').map(({ name }) => `the extension ${name}'s server plugin`)

  return [...existsSync(entry) ? [shown(entry)] : [], ...built]
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

// Prerendered with `prerender: true`, or holding a server island; a list or a function names which of its paths are.
async function prerenderNote(route: Route): Promise<string[]> {
  const server = await serverOf(route.file)
  const prerender = server?.analysis.page?.settings.get('prerender')
  const value = prerender && server!.source.slice(prerender.value.start, prerender.value.end)

  if (value === 'false')
    return []

  if (value === 'true' || (route.params.length === 0 && await reachesServerIsland(route.file)))
    return ['prerendered']

  return value === undefined ? [] : ['prerendered as its prerender setting lists']
}

// A param refusing what its matcher does not take, shown as its file names it: `/items/:id=integer`.
function withMatchers(path: string, route: Route): string {
  return path.replace(PARAM, (param, name: string) => route.matchers?.[name] === undefined ? param : `${param}=${route.matchers[name]}`)
}

function localeNotes(copy: { locale: string | undefined, host?: string }, settings: LocaleSettings | undefined): string[] {
  if (copy.locale === undefined || settings === undefined)
    return []

  return [copy.host === undefined ? copy.locale : `${copy.locale} at ${copy.host}`]
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
