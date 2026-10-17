import type { AnyElysia } from 'elysia'
import type { ClientOptions } from '../build/client'
import type { Action, ActionError, ActionProtection, FailureData, ResultOf, Settles, Success } from '../runtime/action'
import type { Duration } from '../runtime/duration'
import type { EventReader, NodeAt, Optional, SocketOf, SocketOptions, SocketPath, StreamMethod, StreamOf, StreamOptions, StreamPath, StreamStatus } from '../runtime/live'
import type { PagesOptions } from '../server/app'
import type { ClientBuild } from '../server/client'
import type { BrowserOptions, TestPage } from './browser'
import type { PageReading } from './page'
import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { beforeEach } from 'bun:test'
import { Elysia } from 'elysia'
import { clientDir, inOutput, testWorker } from '../build/assets'
import { buildClient } from '../build/client'
import { withConfig } from '../config'
import { clientOptionsOf, PRODUCTION, resolveProject } from '../project'
import { encodeCall, minTimeOf, readActionResponse, SETTLED, STAMP_FIELD } from '../runtime/action'
import { joinBase } from '../runtime/base'
import { durationSeconds } from '../runtime/duration'
import { openSocket, readEvents, routeUrl, streamRequest } from '../runtime/live'
import { effect, root as reactiveRoot } from '../runtime/reactive'
import { PAGE_HEADER, WORK_HEADER, WORK_SCRIPT } from '../runtime/swap'
import { solveWork } from '../runtime/work'
import { MCP_PATH } from '../server/api-modules'
import { servePages } from '../server/app'
import { basePath, routerPath } from '../server/base'
import { shutdown } from '../server/lifecycle'
import { loaderRoot } from '../server/loader'
import { drainQueues } from '../server/queue'
import { sendFrom } from '../server/rewrite'
import { SITEMAP } from '../server/site-paths'
import { signStamp, stampTime } from '../server/stamp'
import { memoryFiles } from '../server/storage'
import { servedThrough } from '../server/visit'
import { proofOfWork, signWork } from '../server/work'
import { browse } from './browser'
import { cookieJar } from './cookies'
import { NativeFormData, NativeHeaders, NativeRequest, NativeURL, NativeWebSocket, withNatives } from './natives'
import { readPage, sitemapUrls } from './page'
import { testRoot } from './root'

export type { A11yViolation, BrowserOptions, TestPage, WaitForOptions, WaitOptions } from './browser'
export { browse, browserPath } from './browser'
export type { CookieJar } from './cookies'
export { cookieJar } from './cookies'
export type { Mounted } from './mount'
export { mount, readPersisted, settle, writePersisted } from './mount'
export type { Found, PageReading } from './page'
export { scratchDir } from './scratch'
export { solveWork }

export interface TestOptions extends PagesOptions {
  // The plugins the server entry uses before the pages, in order, such as `session()`: their derives reach `ctx.locals` and their cookies the next request.
  use?: AnyElysia[] | undefined
  // What the app's Elysia `derive` would add for a request, such as the signed-in user, read by pages, guards and actions as `ctx.locals`.
  locals?: ((request: Request) => Record<string, unknown> | Promise<Record<string, unknown>>) | undefined
  // Loads pages in a headless Chrome with `open()`, served from the islands built for the browser.
  browser?: boolean | BrowserOptions | undefined
  // Builds the islands for the browser, unminified, into `.kay/test-client`, or `.kay/client` with `browser`, so one a browser cannot build, such as a server module reaching it, fails `testSite()` here and not only under `kay dev`; no browser needed. On unless `false`, built again only when the files under `src`, the routes or the API change.
  islands?: boolean | undefined
}

// The page, with its head and its elements read from `html`.
export interface Visit extends PageReading {
  // Where the last redirect led, path and query.
  url: string
  status: number
  headers: Headers
  html: string
}

export interface VisitInit {
  headers?: Record<string, string> | undefined
}

// A text field, or a file input's `File`.
export type FormValue = string | Blob

// What a call gives back: every value of a handler returning an async iterable, else what it returned.
type Tested<Output> = Success<Output> extends infer Value ? Value extends AsyncIterable<infer Item> ? Item[] : Value : never

type InputOf<Target> = Target extends Action<infer Input, unknown> ? Input : never
// A call to an action whose fields are all optional, or that takes none, may leave its input out.
type CallArguments<Target> = object extends InputOf<Target> ? [input?: InputOf<Target> | FormData, init?: VisitInit & { from?: string }] : [input: InputOf<Target> | FormData, init?: VisitInit & { from?: string }]

export interface TestSite {
  // A GET as a browser makes it: earlier cookies sent, redirects followed.
  visit: (path: string, init?: VisitInit) => Promise<Visit>
  // A plain form post from the page at `from`, multipart as kay's forms send it, followed back to wherever the action sends the browser. A `Visit` as `from` posts where its form does, with the stamp `minTime` reads, from the URL the browser shows it at, the action's own for a page a refused post answered.
  // A post to an action with `minTime` goes through as if its form had been open long enough; `openedFor` sends one as if open that long instead, `0` as if just opened.
  submit: <Input, Honeypot extends string = never>(action: Action<Input, unknown, Honeypot>, fields: Partial<Record<Extract<keyof Input, string> | Honeypot | typeof STAMP_FIELD, FormValue | FormValue[] | undefined>>, init?: VisitInit & { from?: string | Visit, openedFor?: Duration | 0 }) => Promise<Visit>
  // The call an island makes, with its input or a form's fields: the result, an `ActionError` thrown, or an `ActionRedirect` when it redirects. `from` names the page it is made on, whose params the action reads.
  // A handler returning an async iterable gives every value once the stream ended, and throws when it failed.
  call: <Target extends Action<never, unknown>>(action: Target, ...call: CallArguments<Target>) => Promise<Tested<ResultOf<Target>>>
  // A call expected to be refused, as `call` makes it: the `ActionError` with its status, errors and typed data; one that went through fails the test, and any other error is thrown.
  refusal: <Target extends Action<never, unknown>>(action: Target, input: InputOf<Target> | FormData, init?: VisitInit & { from?: string }) => Promise<ActionError<FailureData<ResultOf<Target>>>>
  // The site's MCP endpoint, as an agent calls it: `mcp: true` serves it. Calls carry the cookies so far and the headers given, such as an `Authorization` bearer token.
  mcp: {
    // The tools `tools/list` gives.
    tools: (init?: VisitInit) => Promise<McpTool[]>
    // A call to the tool named `name`, which a model would make: its result, with `isError` set when the app refused it, and the HTTP `status` of the answer, 401 when a guard asked for a sign-in. A request the endpoint answers with a protocol error, such as an unknown tool, is thrown.
    call: (name: string, args?: object, init?: VisitInit) => Promise<McpCall>
  }
  // A request to any route, an API module's included, with the cookies so far; the response as it is, redirects not followed.
  fetch: (path: string, init?: Omit<RequestInit, 'headers'> & VisitInit) => Promise<Response>
  // A websocket route of a module under `src/api`, opened as an island opens it, over a server the site starts on a free port the first time; `close()` stops it.
  socket: <Module, const Path extends SocketPath<Module>>(module: Module, path: Path, ...[options]: Optional<SocketOptions<Module, Path> & VisitInit>) => TestSocket<SocketOf<Module, Path>>
  // A route of a module under `src/api` answering with `eventStream()`, read as an island reads it.
  stream: <Module, const Path extends StreamPath<Module>, const M extends StreamMethod<NodeAt<Module, Path>> = never>(module: Module, path: Path, ...[options]: Optional<StreamOptions<Module, Path, M> & VisitInit>) => TestStream<StreamOf<Module, Path, M>>
  // A page loaded in a headless Chrome over a server the site starts on a free port, once `browser` is set; its cookies are the browser's, not `cookies`.
  open: (path: string, options?: BrowserOptions) => Promise<TestPage>
  // The URLs the sitemap at `path` (default `/sitemap.xml`) lists, failing when it does not answer 200.
  sitemap: (path?: string) => Promise<string[]>
  // Runs every job the queues hold whose time has come, those the jobs enqueue included, until none is left; resolves with how many ran.
  runJobs: () => Promise<number>
  cookies: Bun.CookieMap
  handle: (request: Request) => Promise<Response>
  // Closes the pages `open()` opened and stops the server it or `socket()` started, if any.
  close: () => Promise<void>
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpCall {
  isError: boolean
  // The text a model reads, which is the answer's JSON for an action or an API route that returns some.
  text: string
  // The answer parsed, when it is an object.
  data: Record<string, unknown> | undefined
  status: number
}

type Received<Client> = Client extends { on: (listener: (value: infer Value) => void) => unknown } ? Value : never

export type TestSocket<Client> = Client & {
  // Every message received so far, in order.
  received: Received<Client>[]
  // The oldest message `next()` has not returned yet, waiting for one when there is none.
  next: () => Promise<Received<Client>>
}

export type TestStream<Client> = Client & {
  received: Received<Client>[]
  next: () => Promise<Received<Client>>
  // Every value, once the stream ended, failed or was closed.
  finished: () => Promise<Received<Client>[]>
}

const ORIGIN = 'http://localhost'
// The DOM typings of WebSocket hide the options Bun takes, the upgrade's headers among them.
const BunWebSocket = NativeWebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket
const MAX_REDIRECTS = 10
// Each test's client, counted across the run as rate limits are. A private address reads as a proxy's, so a test sending the header the app's `proxy` names still posts as the client it gives.
let clients = 0

function nextClient(): string {
  clients++

  return `10.${clients >> 16 & 255}.${clients >> 8 & 255}.${clients & 255}`
}

// The stamp `minTime` reads, as the browser sends the form it was rendered in: dated `openedFor` ago when given, else the page's own made no younger than the action asks, so a test about something else is not refused as too fast.
function postedStamp(action: Action<never, unknown> & { protection?: ActionProtection<string> }, rendered: string | undefined, openedFor: Duration | 0 | undefined): string | undefined {
  if (openedFor !== undefined)
    return signStamp(action.url, Date.now() - (openedFor === 0 ? 0 : durationSeconds(openedFor, 'openedFor') * 1000))

  const after = action.protection && minTimeOf(action.protection)?.after

  if (after === undefined)
    return rendered

  const latest = Date.now() - after
  const at = stampTime(action.url, rendered)

  return at !== undefined && at <= latest ? rendered : signStamp(action.url, latest)
}

// The solution kay's script sends to an action with `proofOfWork`, to a challenge signed here, as a test posts without a page's script.
function workHeaders(action: Action<never, unknown>): Record<string, string> {
  const work = proofOfWork(action)

  return work ? { [WORK_HEADER]: solveWork(signWork(action.url, work.difficulty, work.maxAge))! } : {}
}

const builds = new Map<string, { key: string, build: Promise<ClientBuild> }>()

// The newest edit and the count of files under the project's sources and pages, which tell a build still current from one the test's own edits outdated.
async function editedAt(root: string, options: ClientOptions): Promise<string> {
  let newest = 0
  let count = 0

  for (const dir of new Set(['src', options.routes ?? 'src/routes', options.api ?? 'src/api'])) {
    const cwd = resolve(root, dir)

    if (!existsSync(cwd))
      continue

    for await (const file of new Bun.Glob('**').scan({ cwd, absolute: true, onlyFiles: true })) {
      newest = Math.max(newest, Bun.file(file).lastModified)
      count++
    }
  }

  return `${newest}:${count}`
}

// The options that tell two builds apart, as far as they can be written down.
function optionsKey(options: ClientOptions): string {
  return JSON.stringify(options, (_, value: unknown) => typeof value === 'bigint' ? String(value) : value)
}

// One build per root and output, rebuilt when its options or sources changed, and one at a time: every build clears and rewrites its output, which the sites of a process share.
// A site not loaded in a browser builds into `.kay/test-client`, so `kay build`'s output stays as it was.
async function islandsBuilt(root: string, options: ClientOptions, inBrowser: boolean): Promise<ClientBuild> {
  const key = `${optionsKey(options)}\0${await editedAt(root, options)}`
  const slot = `${root}\0${inBrowser}`
  const held = builds.get(slot)

  if (held?.key === key)
    return held.build

  const build = (async () => {
    try {
      await held?.build
    }
    catch {}

    return inBrowser ? buildClient(root, options) : inOutput(`test-client${testWorker()}`, async () => buildClient(root, options))
  })()

  builds.set(slot, { key, build })

  return build
}

// The project's pages and actions without a server, their islands built for the browser as a check: pages then render their islands' markup and no scripts.
export async function testSite(options: TestOptions = {}): Promise<TestSite> {
  const root = testRoot(options.root)
  const serving = loaderRoot()

  // The .kay loader and the site are the process's own, so a second project fails here with the way out rather than deep in a page import.
  if (serving !== undefined && serving !== root)
    throw new Error(`kay: this test process already serves ${serving}, and a process serves one project; test ${root} in a process of its own: \`bun test --parallel\` runs each file apart, or run its tests on their own as \`KAY_ROOT=${relative(process.cwd(), root) || '.'} bun test <its test files>\``)

  const loaded = await withConfig(root, options)
  // A site setting none is served where the visits go, so pages reading siteUrl() or siteOrigin() render as in production; files go to memory, fresh for each site, rather than to the store kay.config.ts names.
  const config = { ...loaded, site: loaded.site ?? ORIGIN, storage: options.storage ?? memoryFiles() }
  const project = resolveProject(root, config, { dev: config.dev === true, prebuilt: false, underKayDev: false })
  const inBrowser = options.browser !== undefined && options.browser !== false
  const wanted = inBrowser || options.islands !== false ? await islandsBuilt(root, clientOptionsOf(config, PRODUCTION), inBrowser) : undefined
  // Without a browser the pages render their islands' markup and load no script, so the build only had to succeed.
  const client: ClientBuild = inBrowser && wanted ? wanted : { entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: clientDir(root) }
  const browser = typeof options.browser === 'object' ? options.browser : {}
  const pages = await servePages(project, () => client)
  const locals = options.locals
  const before = [...options.use ?? [], ...locals ? [new Elysia().derive({ as: 'global' }, async ({ request }) => locals(request))] : []]
  const app = before.length === 0 ? pages : before.reduce<AnyElysia>((served, plugin) => served.use(plugin), new Elysia()).use(pages)
  const jar = cookieJar()
  const base = basePath(config.base)
  let address = nextClient()

  // A site made at the top of a file or a describe posts as a new client in each test, so no test meets the rate limits another one's posts counted; one made inside a test, or outside bun test, keeps one.
  try {
    beforeEach(() => {
      address = nextClient()
    })
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

  const send = async (path: string, init: Omit<RequestInit, 'headers'> & VisitInit): Promise<Response> => {
    const url = new NativeURL(path, ORIGIN)
    const routed = routerPath(url.pathname, base)
    const request = new NativeRequest(new NativeURL(routed + url.search, ORIGIN), { ...init, headers: new NativeHeaders(init.headers), redirect: 'manual' })

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

    return { url: path, status: current.status, headers: current.headers, html, ...readPage(html) }
  }

  // The URL the browser shows a page at that answered a post in place: the one posted to.
  const answeredAt = new WeakMap<Visit, string>()
  let server: Bun.Server<unknown> | undefined
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

  const call: TestSite['call'] = async (action, ...[input, init = {}]) => {
    const { headers, body } = encodeCall(input)

    const sent: Record<string, string> = { ...headers, origin: ORIGIN }

    if (init.from !== undefined)
      sent[PAGE_HEADER] = shown(init.from)

    const answer = await readActionResponse<unknown>(await send(action.url, { method: 'POST', headers: { ...sent, ...workHeaders(action), ...init.headers }, body }), action.url)

    return (isStream(answer) ? await streamedValues(answer, action.url) : answer) as Tested<ResultOf<typeof action>>
  }

  interface RpcResult { tools?: McpTool[], isError?: boolean, content?: { text: string }[], structuredContent?: Record<string, unknown> }

  let rpcId = 0

  const rpc = async (method: string, params: object, init: VisitInit = {}): Promise<{ status: number, result: RpcResult }> => {
    const response = await send(MCP_PATH, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream', ...init.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })
    const reply = await withNatives(async () => response.json() as Promise<unknown>) as { result?: RpcResult, error?: { message: string } }

    if (reply.error)
      throw new Error(`kay: ${method} was refused: ${reply.error.message}`)

    return { status: response.status, result: reply.result! }
  }

  return {
    cookies: jar.cookies,
    handle,
    mcp: {
      tools: async init => (await rpc('tools/list', {}, init)).result.tools ?? [],
      call: async (name, args = {}, init) => {
        const { status, result } = await rpc('tools/call', { name, arguments: args }, init)

        return { isError: result.isError === true, text: (result.content ?? []).map(part => part.text).join(''), data: result.structuredContent, status }
      },
    },
    runJobs: drainQueues,
    sitemap: async (path = SITEMAP) => {
      const response = await send(path, {})

      if (response.status !== 200)
        throw new Error(`kay: ${path} answered ${response.status}`)

      return sitemapUrls(await withNatives(async () => response.text()))
    },
    fetch: async (path, init = {}) => send(path, init),
    socket: (module, path, ...[options]) => {
      const url = routeUrl(module, path, options as Parameters<typeof routeUrl>[2])
      const client = openSocket(() => new BunWebSocket(`ws://localhost:${listening().port}${url}`, { headers: { ...options?.headers, ...jar.cookies.size > 0 ? { cookie: jar.header(joinBase(base, url)) } : {} } }))
      const tested = Object.assign(client, inbox(client))

      connections.add(client)
      client.start()

      return tested as never
    },
    stream: (module, path, ...[options]) => {
      const url = routeUrl(module, path, options as Parameters<typeof routeUrl>[2])
      const init = streamRequest(options)
      const reader = readEvents(async signal => send(url, { ...init, headers: { ...init.headers, ...options?.headers }, signal }), init.method === 'GET')
      const tested = Object.assign(reader, inbox(reader))
      const finished = new Promise<unknown[]>((resolve) => {
        reactiveRoot(dispose => effect(() => {
          const status = reader.status()

          if (status !== 'connecting' && status !== 'open') {
            dispose()
            resolve(tested.received)
          }
        }))
      })

      Object.assign(tested, { finished: async () => finished })
      connections.add(reader)
      reader.start()

      return tested as never
    },
    open: async (path, browserOptions) => {
      if (options.browser === undefined || options.browser === false)
        throw new Error('kay: open() loads pages in a browser, which needs their islands built: testSite({ browser: true })')

      const page = await browse(new URL(path, `http://localhost:${listening().port}`).href, { ...browser, ...Object.fromEntries(Object.entries(browserOptions ?? {}).filter(([, value]) => value !== undefined)) })
      const close = page.close

      opened.add(page)
      page.close = () => {
        opened.delete(page)
        close()
      }

      return page
    },
    close: async () => {
      for (const page of opened)
        page.close()

      // The sockets and streams the test left open are closed with the site, and the stop is forced as nothing but the test is left to finish.
      for (const connection of connections)
        connection.close()

      connections.clear()

      if (server)
        await shutdown(app, true)

      server = undefined
    },
    visit: async (path, init = {}) => follow(await send(path, { headers: init.headers }), path, init.headers),
    submit: async (action, fields, init = {}) => {
      const page = typeof init.from === 'object' ? init.from : undefined
      const from = typeof init.from === 'object' ? init.from.url : init.from ?? '/'
      const target = page?.find('form').map(form => form.attributes.action).find(url => url !== undefined && new URL(url, ORIGIN).pathname.endsWith(action.url))
      const url = target === undefined ? undefined : new URL(target, ORIGIN)
      const posted = url === undefined ? action.url : url.pathname + url.search
      const form = new NativeFormData()

      const rendered = url === undefined ? undefined : page?.find(`form[action^="${url.pathname}"] input[name="${STAMP_FIELD}"]`)[0]?.attributes.value
      const stamp = postedStamp(action, rendered, init.openedFor)

      if (stamp !== undefined && !(STAMP_FIELD in fields))
        form.set(STAMP_FIELD, stamp)

      // Its `workChallenge` fields post their solution, as kay's script sends them.
      for (const field of url === undefined ? [] : page?.find(`form[action^="${url.pathname}"] input[${WORK_SCRIPT}]`) ?? []) {
        const { name, [WORK_SCRIPT]: challenge } = field.attributes

        if (name !== undefined && challenge !== undefined && !(name in fields))
          form.set(name, solveWork(challenge) ?? '')
      }

      for (const [name, value] of Object.entries(fields as Record<string, FormValue | FormValue[] | undefined>)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined)
            form.append(name, item)
        }
      }

      const response = await send(posted, {
        method: 'POST',
        headers: { origin: ORIGIN, referer: new URL((page && answeredAt.get(page)) ?? shown(from), ORIGIN).href, ...workHeaders(action), ...init.headers },
        body: form,
      })
      const visit = await follow(response, from, init.headers)

      if (!response.headers.has('location'))
        answeredAt.set(visit, shown(posted))

      return visit
    },
    call,
    refusal: async (action, input, init) => {
      try {
        await call(action, ...[input, init] as CallArguments<typeof action>)
      }
      catch (error) {
        // `Target` only bounds the action, so its own `refused` types the data as unknown.
        if (action.refused(error))
          return error as ActionError<FailureData<ResultOf<typeof action>>>

        throw error
      }

      throw new Error(`kay: the call to ${action.url} went through, where a refusal was expected`)
    },
  }
}

function isStream(value: unknown): value is EventReader<unknown> & Settles {
  return (value as Partial<Settles> | null | undefined)?.[SETTLED] !== undefined
}

async function streamedValues(stream: EventReader<unknown> & Settles, url: string): Promise<unknown[]> {
  const values: unknown[] = []

  stream.on(value => void values.push(value))

  const status = await new Promise<StreamStatus>(resolve => stream[SETTLED](resolve))

  if (status !== 'done')
    throw new Error(`kay: the stream ${url} answered ${status} after ${values.length} values`)

  return values
}

// Keeps every message a client receives, for a test to read in order.
function inbox<T>(client: Pick<EventReader<T>, 'on'>): { received: T[], next: () => Promise<T> } {
  const received: T[] = []
  const waiting: ((value: T) => void)[] = []
  let read = 0

  client.on((value) => {
    received.push(value)

    const waiter = waiting.shift()

    if (waiter) {
      read++
      waiter(value)
    }
  })

  return {
    received,
    next: async () => read < received.length ? received[read++]! : new Promise<T>(resolve => waiting.push(resolve)),
  }
}
