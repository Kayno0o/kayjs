import type { AnyElysia } from 'elysia'
import type { ClientOptions } from '../build/client'
import type { ClientBuild } from '../server/client'
import type { LogEntry } from '../server/log'
import type { TestPage } from './browser'
import type { SiteScope } from './site-scope'
import type { TestOptions, TestSite, Visit, VisitInit } from './site-types'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { afterAll, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'
import { clientDir, inOutput, KAY_DIR, testWorker } from '../build/assets'
import { buildClient } from '../build/client'
import { KayCompileError } from '../build/transform'
import { buildingTestSite } from '../config-extensions'
import { withConfig } from '../config-loader'
import { mountedAt } from '../dev/base-proxy'
import { BuildStamps } from '../dev/fingerprint'
import { clientOptionsOf, PRODUCTION, resolveProject } from '../project'
import { joinBase } from '../runtime/base'
import { solveWork } from '../runtime/work'
import { MCP_PATH, mcpPath } from '../server/api-modules'
import { servePages } from '../server/app'
import { basePath, routerPath } from '../server/base'
import { clientOptionsKey } from '../server/client'
import { shutdown } from '../server/lifecycle'
import { forgetStamps } from '../server/live'
import { loaderRoot } from '../server/loader'
import { tapLogs } from '../server/log'
import { mcpKeySetting } from '../server/mcp-key'
import { memoryNotifications } from '../server/notifications'
import { checkProxy, memoryRates } from '../server/protection'
import { withProxyKey } from '../server/proxy-key'
import { setPushLoose } from '../server/push-settings'
import { drainQueues, memoryJobs } from '../server/queue'
import { sendFrom } from '../server/rewrite'
import { memoryRooms } from '../server/rooms'
import { acceptCookieData, memorySessions } from '../server/session'
import { SITEMAP } from '../server/site-paths'
import { memoryFiles } from '../server/storage'
import { servedThrough } from '../server/visit'
import { memoryVitals } from '../server/vitals-store'
import { browse } from './browser'
import { testContent } from './content'
import { cookieJar, withKept } from './cookies'
import { checkOnly, lazyNativePlugins } from './lazy-plugins'
import { NativeRequest, NativeURL, withNatives } from './natives'
import { pruneTestOutputs, touchOutput, touchOutputIfOld } from './outputs'
import { readPage, settledHtml, sitemapUrls } from './page'
import { testRoot } from './root'
import { actionsOf, formUrl, renderedStamp } from './site-actions'
import { apiOf } from './site-api'
import { mcpOf } from './site-mcp'
import { ORIGIN, withDefaults } from './site-scope'
import { socketsOf } from './site-socket'
import { closeAfterTests, openSites } from './sites'
import { assertKayWritable } from './writable'

export type { A11yViolation, BrowserOptions, ClickOptions, DialogHandler, FetchedResponse, FulfillOptions, PageDialog, PageRequest, PageResponse, PointerOptions, RouteHandler, RouteMatch, TestPage, WaitForOptions, WaitOptions } from './browser'
export { browse, browserPath } from './browser'
export type { ContentSeed, SeedEntry, TestContent } from './content'
export type { CookieJar } from './cookies'
export { cookieJar } from './cookies'
export type { Interactions } from './interact'
export type { Mounted } from './mount'
export { mountComponent, persistedCookie, readPersisted, settle, writePersisted } from './mount'
export type { EnvOverride, EnvRestore } from './override-env'
export { overrideEnv } from './override-env'
export type { Found, PageReading } from './page'
export { scratchDir } from './scratch'
export type { FakeService, ServiceAnswer, ServiceHandler, ServiceRequest, ServiceRoutes } from './service'
export { fakeService } from './service'
export type { ApiResult, FormValue, McpCall, McpTool, TestOptions, TestSite, TestSocket, TestStream, Visit, VisitInit } from './site-types'
export type { WaitUntilOptions } from './wait'
export { solveWork }
export { waitUntil } from './wait'

const MAX_REDIRECTS = 10

// Each test's client, counted across the run as rate limits are. A private address reads as a proxy's, so a test sending the header the app's `proxy` names still posts as the client it gives.
let clients = 0

function nextClient(): string {
  clients++

  return `10.${clients >> 16 & 255}.${clients >> 8 & 255}.${clients & 255}`
}

// What a site loading no browser holds of a check that found nothing to build again: its islands are never read.
const CHECKED: ClientBuild = { entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: '' }

const ROOT_MANIFEST = /^(?:package\.json|bun\.lockb?|tsconfig.*\.json|kay\.config\.\w+)$/

// The options key and a hash of the root files that shape a build without being read by it (the dependencies they pin, the paths it resolves, the config), so a record kept across runs is not trusted past a change to them.
function recordKey(root: string, key: string): string {
  const hash = new Bun.CryptoHasher('sha1')

  try {
    for (const name of readdirSync(root).filter(name => ROOT_MANIFEST.test(name)).sort())
      hash.update(`${name}\0`).update(readFileSync(join(root, name)))
  }
  catch {}

  return `${key}\0${hash.digest('hex')}`
}

// A walk that fails, as a test deleting a file mid-way does, only means the check builds.
async function recordFresh(stamps: BuildStamps): Promise<boolean> {
  try {
    return await stamps.fresh()
  }
  catch {
    return false
  }
}

const builds = new Map<string, { key: string, stamps: BuildStamps, running: () => boolean, build: Promise<ClientBuild> }>()

// One build per root and output, rebuilt when its options changed or a file it read did, as `kay dev`'s stamps tell, and one at a time: every build clears and rewrites its output, which the sites of a process share.
// A build still running is the one asked for, and one that failed stays failed until a source changes. A site not loaded in a browser builds into `.kay/test-client`, so `kay build`'s output stays as it was.
async function islandsBuilt(root: string, options: ClientOptions, inBrowser: boolean): Promise<ClientBuild> {
  const key = clientOptionsKey(options)
  const slot = `${root}\0${inBrowser}`
  const held = builds.get(slot)
  // One output, and so one record, per options key: files alternating options each find the check they left.
  const output = `test-client${testWorker()}.${Bun.hash(key).toString(36)}`

  if (held?.key === key && (held.running() || await held.stamps.current())) {
    if (!inBrowser)
      touchOutputIfOld(root, output)

    return held.build
  }

  // Another site asked for one while the stamps were compared.
  const latest = builds.get(slot)

  if (latest !== held && latest?.key === key)
    return latest.build

  // A check build leaves its record in the output, so a later file of the run, or a later run, whose sources are the same builds nothing again.
  if (!inBrowser) {
    pruneTestOutputs(root, output)
    touchOutput(root, output)
  }

  const stamps = inBrowser ? new BuildStamps(root) : new BuildStamps(root, { output: join(root, KAY_DIR, output), options: recordKey(root, key), testRecord: true })
  let running = true
  const build = (async () => {
    try {
      await latest?.build
    }
    catch {}

    try {
      return await (inBrowser ? buildClient(root, options, stamps) : inOutput(output, async () => await recordFresh(stamps) ? CHECKED : buildClient(root, options, stamps)))
    }
    finally {
      running = false

      if (!inBrowser)
        touchOutput(root, output)
    }
  })()

  builds.set(slot, { key, stamps, running: () => running, build })

  return build
}

// Without a browser the build is only a check, so a file that does not compile does not fail every site: the visit of a page importing it fails with that file's error, and the tests of other pages go on.
async function islandsChecked(root: string, options: ClientOptions, inBrowser: boolean): Promise<ClientBuild | undefined> {
  try {
    return await islandsBuilt(root, options, inBrowser)
  }
  catch (error) {
    if (inBrowser || !(error instanceof KayCompileError))
      throw error

    return undefined
  }
}

// The project's pages and actions without a server, their islands built for the browser as a check: pages then render their islands' markup and no scripts.

export async function testSite(options: TestOptions = {}): Promise<TestSite> {
  const root = testRoot(options.root)
  const serving = loaderRoot()

  // The .kay loader and the site are the process's own, so a second project fails here with the way out rather than deep in a page import.
  if (serving !== undefined && serving !== root)
    throw new Error(`kay: this test process already serves ${serving}, and a process serves one project; test ${root} in a process of its own: \`bun test --parallel\` runs each file apart, or run its tests on their own as \`KAY_ROOT=${relative(process.cwd(), root) || '.'} bun test <its test files>\``)

  lazyNativePlugins()
  // A site under test plays by `kay dev`'s rules for push: keys generated, a push service on loopback.
  setPushLoose(true)
  acceptCookieData()

  const loaded = await withConfig(root, options)
  // A site setting none is served where the visits go, so pages reading siteUrl() or siteOrigin() render as in production; files go to memory, fresh for each site, rather than to the store kay.config.ts names, and so do the sessions, jobs, rate counts, presence rooms, vitals and notifications of its `store` (sessions only when it keeps them), its cached and live values staying in the process.
  const mcpKey = options.mcpKey ?? (mcpKeySetting(loaded.mcp) === undefined ? undefined : crypto.randomUUID())
  const config = { ...loaded, ...mcpKey !== undefined && loaded.mcp !== undefined && loaded.mcp !== false && { mcp: { ...loaded.mcp === true ? {} : loaded.mcp, key: mcpKey } }, site: loaded.site ?? ORIGIN, fileStore: options.fileStore ?? options.storage ?? memoryFiles(), store: options.store === undefined && loaded.store !== undefined ? { ...loaded.store.sessions && { sessions: memorySessions() }, jobs: memoryJobs(), rates: memoryRates(), rooms: memoryRooms(), vitals: memoryVitals(), notifications: memoryNotifications() } : loaded.store }
  const project = resolveProject(root, config, { dev: config.dev === true, prebuilt: false, underKayDev: false, devRoutes: config.dev === true })
  const inBrowser = options.browser !== undefined && options.browser !== false
  // The client as a browser loads it, built for real: the stylesheets and island bundles pages link.
  const realClient = inBrowser || options.styles === true
  const proxyKey = options.proxyKey?.trim()
  const keyHeader = proxyKey === undefined ? undefined : checkProxy(config.proxy)?.key

  if (proxyKey !== undefined) {
    if (proxyKey === '')
      throw new Error('kay: testSite({ proxyKey }) needs a non-empty key; send no key from a call with an empty header of the name `proxy.key` gives')

    if (keyHeader === undefined)
      throw new Error('kay: testSite({ proxyKey }) needs the app to set `proxy.key` in kay.config.ts, the header the key travels in')

    if (config.dev === true)
      throw new Error('kay: testSite({ proxyKey }) checks nothing with `dev: true`, as `kay dev` does not check the key')

    if (inBrowser)
      throw new Error('kay: testSite({ proxyKey }) does not reach `open()`, whose browser sends no proxy key header; test the key check without `browser`')
  }

  if (realClient || options.islands !== false)
    assertKayWritable(root)

  const wanted = realClient || options.islands !== false ? await islandsChecked(root, realClient ? clientOptionsOf(config, PRODUCTION) : checkOnly(clientOptionsOf(config, PRODUCTION)), realClient) : undefined
  // Without a browser or `styles` the pages render their islands' markup and load no script or stylesheet, so the build was only a check.
  const client: ClientBuild = realClient && wanted ? wanted : { entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: clientDir(root) }
  const browser = typeof options.browser === 'object' ? options.browser : {}
  const jar = cookieJar()
  const boot = async (): Promise<Awaited<ReturnType<typeof servePages>>> => buildingTestSite(jar.cookies, async () => servePages(project, () => client, true))
  const pages = await (proxyKey === undefined ? boot() : withProxyKey(proxyKey, boot))
  const locals = options.locals
  const before = [...options.use ?? [], ...locals ? [new Elysia().derive({ as: 'global' }, async ({ request }) => locals(request))] : []]
  const app = before.length === 0 ? pages : before.reduce<AnyElysia>((served, plugin) => served.use(plugin), new Elysia()).use(pages)
  const { content, release } = await testContent(root, config.contentConfig)
  const base = basePath(config.base)
  let address = nextClient()

  // A site made at the top of a file or a describe posts as a new client in each test, so no test meets the rate limits another one's posts counted; one made inside a test, or outside bun test, keeps one.
  const logs: LogEntry[] = []
  const untap = tapLogs(entry => void logs.push(entry))

  try {
    beforeEach(() => {
      address = nextClient()
      logs.length = 0
    })
    afterAll(release)
  }
  catch {}

  // What kay sends through the app on the visitor's behalf, as the page a refused post renders, goes through all of it, as a server would send it.
  const handle = async (request: Request): Promise<Response> => {
    servedThrough(request, handle)

    return withNatives(async () => app.handle(request))
  }

  // A path as the browser shows it, under `base`; one already under it stays as it is.
  const shown = (path: string): string => {
    if (base === '')
      return path

    const url = new NativeURL(path, ORIGIN)

    return joinBase(base, routerPath(url.pathname, base)) + url.search
  }

  // The URL the browser shows a page at that answered a post in place: the one posted to.
  const answeredAt = new WeakMap<Visit, string>()
  let server: Bun.Server<unknown> | undefined
  let mounted: ReturnType<typeof mountedAt> | undefined
  const opened = new Set<TestPage>()
  const connections = new Set<{ close: () => void }>()

  const listening = (): Bun.Server<unknown> => {
    if (!server) {
      app.listen({ port: 0, hostname: 'localhost' })
      server = app.server!
      server.unref()
    }

    return server
  }

  // Where the browser loads pages: under a base, through a proxy taking it off as the one in front of the site does.
  const pageOrigin = (): string => {
    const origin = `http://localhost:${listening().port}`

    return base === '' ? origin : (mounted ??= mountedAt(origin, base)).origin
  }

  // Takes the site off the registry that closes it once the tests ran, as a close by hand leaves nothing to close.
  let forget: () => void = () => undefined
  const scoped = (defaults: Record<string, string>): TestSite => {
    const send = async (path: string, init: Omit<RequestInit, 'headers'> & VisitInit): Promise<Response> => {
      const url = new NativeURL(path, ORIGIN)
      const routed = routerPath(url.pathname, base)
      const request = new NativeRequest(new NativeURL(routed + url.search, ORIGIN), { ...init, headers: withDefaults(defaults, init.headers, keyHeader), redirect: 'manual' })

      sendFrom(request, address)

      return jar.send(handle, request, joinBase(base, routed))
    }

    const follow = async (response: Response, url: string, headers?: Record<string, string>): Promise<Visit> => {
      let current = response
      let path = shown(url)

      for (let redirects = 0; current.status >= 300 && current.status < 400 && current.headers.has('location'); redirects++) {
        if (redirects === MAX_REDIRECTS)
          throw new Error(`kay: more than ${MAX_REDIRECTS} redirects from ${url}`)

        const next = new URL(current.headers.get('location')!, new URL(path, ORIGIN))

        // Another site is not this app's to answer, so the visit ends at the redirect.
        if (next.origin !== ORIGIN)
          break

        path = next.pathname + next.search
        current = await send(path, { headers })
      }

      // A page streamed after its shell renders on as it is read.
      const html = await withNatives(async () => current.text())

      let settled: Visit['settled'] | undefined
      const reading = readPage(html)

      return {
        url: path,
        status: current.status,
        headers: current.headers,
        html,
        ...reading,
        css: async () => {
          if (!realClient)
            throw new Error('kay: css() reads the stylesheets the app builds, which a site loads with testSite({ styles: true }) or testSite({ browser: true })')

          const sheets = reading.find('style').map(style => style.html)

          for (const link of reading.find('link[rel~=stylesheet]')) {
            const response = await send(link.attributes.href ?? '', {})

            if (response.status !== 200)
              throw new Error(`kay: the stylesheet ${link.attributes.href} answered ${response.status}`)

            sheets.push(await withNatives(async () => response.text()))
          }

          return sheets.join('\n')
        },
        stamp: (action) => {
          const url = formUrl(reading, action)

          return url && renderedStamp(reading, url)
        },
        get settled() {
          const text = settledHtml(html)

          settled ??= { ...readPage(text), html: text }

          return settled
        },
      }
    }

    const scope: SiteScope = { defaults, keyHeader, base, jar, send, follow, shown, listening, connections, answeredAt, mcpKey, mcpUrl: () => mcpPath(config.mcp) ?? MCP_PATH }

    return {
      cookies: jar.cookies,
      ...mcpOf(scope),
      ...apiOf(scope),
      ...socketsOf(scope),
      ...actionsOf(scope),
      content,
      logs,
      handle,
      runJobs: drainQueues,
      sitemap: async (path = SITEMAP) => {
        const response = await send(path, {})

        if (response.status !== 200)
          throw new Error(`kay: ${path} answered ${response.status}`)

        return sitemapUrls(await withNatives(async () => response.text()))
      },
      fetch: async (path, init = {}) => send(path, init),
      as: (who) => {
        const given = withDefaults({}, typeof who === 'string' ? { cookie: who } : who)
        const merged = withDefaults(defaults, Object.fromEntries(given))

        // Cookies stack by name, the newer winning, as headers do.
        if (defaults.cookie !== undefined && given.has('cookie'))
          merged.set('cookie', withKept(given.get('cookie'), defaults.cookie))

        return scoped(Object.fromEntries(merged))
      },
      open: async (path, browserOptions) => {
        if (options.browser === undefined || options.browser === false)
          throw new Error('kay: open() loads pages in a browser, which needs their islands built: testSite({ browser: true })')

        const url = new URL(path, pageOrigin())

        url.pathname = joinBase(base, routerPath(url.pathname, base))

        // A site made with `as(cookie)` signs the browser in too.
        const page = await browse(url.href, { ...browser, ...defaults.cookie !== undefined && { cookies: defaults.cookie }, ...Object.fromEntries(Object.entries(browserOptions ?? {}).filter(([, value]) => value !== undefined)) })
        const close = page.close

        opened.add(page)
        page.close = () => {
          opened.delete(page)
          close()
        }

        return page
      },
      close: async () => {
        forget()
        untap()

        for (const page of opened)
          page.close()

        // The sockets and streams the test left open are closed with the site, and the stop is forced as nothing but the test is left to finish.
        for (const connection of connections)
          connection.close()

        connections.clear()

        mounted?.stop()
        mounted = undefined

        if (server)
          await shutdown(app, true)

        server = undefined
        await release()

        // The last site gone, the next file of the process meets the invalidation times and the push switch as a process just started would.
        if (openSites() === 0) {
          forgetStamps()
          setPushLoose(false)
        }
      },
      visit: async (path, init = {}) => follow(await send(path, { headers: init.headers }), path, init.headers),
    }
  }

  const site = scoped({ ...options.headers, ...keyHeader !== undefined && proxyKey !== undefined && { [keyHeader]: proxyKey } })

  forget = closeAfterTests(site.close)

  return site
}
