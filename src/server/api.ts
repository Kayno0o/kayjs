import type { BunPlugin } from 'bun'
import type { KayConfig } from '../config'
import type { Locals } from '../runtime'
import type { EventStream } from '../runtime/live'
import type { ActionOptions } from './actions'
import type { BodyLimit } from './body'
import type { CorsOptions, CorsRule } from './cors'
import type { LoadedGuard } from './guards'
import type { MountedApi } from './openapi'
import type { RouteMount } from './routes'
import type { Span } from './trace'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { Cookie, Elysia, ElysiaCustomStatusResponse, ElysiaFile } from 'elysia'
import { projectPaths } from '../project'
import { API_MOUNT, END_EVENT, ERROR_EVENT } from '../runtime/live'
import { kayLog } from '../runtime/log'
import { encodeValue, unsendable } from '../runtime/wire'
import { admitCrossSite, crossSiteRefused, guardsFirst, inLocale, passGuards } from './actions'
import { importModule } from './bundle'
import { corsAdmits, corsResponse, corsRule, preflight, withCors } from './cors'
import { loadGuard, requiredGuards } from './guards'
import { answeringRequest } from './log'
import { requestId } from './protection'
import { sharedContext } from './render'
import { reportServerError } from './report'
import { requestUrl } from './request-url'
import { apiMounts, directoriesUp, falseKeys, fileAt } from './routes'
import { answered, failed, SERVER_SPAN, startSpan } from './trace'

// A module under the API directory or an extension's, as `pages()` mounts it.
export interface ApiModule {
  file: string
  // Where its routes are served: `/api/chat` for `src/api/chat.ts`, `/api` for `src/api/index.ts`.
  mount: string
  // The `_guard.ts` files of its directory and above, outermost first.
  guards: ApiGuard[]
  // No guard is asked of it on a site with `requireGuards`: it sets `api({ guards: false })`, or a library serves it.
  open?: true | undefined
}

export interface ApiGuard {
  file: string
  // Where it sits as the API directory and the extensions' laid over it read, whatever machine built the server: `admin/_guard.ts`.
  path: string
}

export const API_PREFIX = '/api'
const GUARD = '_guard.ts'
const API_OPTIONS = /\bapi\s*\(\s*\{/
// Tests, declarations, and files or directories starting with `_`, guards and helpers, are no modules.
const NOT_A_MODULE = /(?:^|\/)_|\.(?:test|spec|d)\.ts$/
// What a body Elysia streams, awaits or asks for its response has: a generator, a thenable, an object with `toResponse()`.
const STREAMED = ['next', 'then', 'toResponse']
const TS_FILE = /\.ts$/
const INDEX = /(?:^|\/)index$/
const TRAILING_SLASH = /\/$/
// What `dirname` gives a file at the top of its directory, as the prefix ends the path.
const CURRENT_DIR = /\/\.$/
// What Elysia reads as a parameter or a wildcard, or breaks the code it generates on, in a mount path.
const ROUTER_SYNTAX = /[:*']/
// Bun closes a connection idle for 10 s by default, and proxies after a minute or so: a comment line now and then keeps a quiet stream open.
const HEARTBEAT_MS = 5000
const HEARTBEAT = new TextEncoder().encode(':\n\n')
const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/g
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
// Where `api({ bodyLimit })` keeps its limit on the instance it makes.
const BODY_LIMIT = Symbol.for('kay.bodyLimit')
// Where `api({ cors })` keeps the origins it lets in.
const CORS = Symbol.for('kay.cors')

// The requests the guards of their module let through, whose later errors are no refused input.
const admitted = new WeakSet<Request>()

// Where a failing event stream reports its error: logged, and handed to `onError` once the route answering with it is known.
const streamReporters = new WeakMap<Response, { report: (error: unknown) => void }>()

// The app's API modules and its extensions', as `pages()` serves them.
export async function projectApi(root: string, config: Pick<KayConfig, 'api' | 'extensions'>): Promise<ApiModule[]> {
  const [app, ...mounts] = apiTrees(root, config)

  return scanApi(app!.dir, mounts)
}

// The app's API directory at the root of the API tree, then each extension's under its prefix.
export function apiTrees(root: string, config: Pick<KayConfig, 'api' | 'extensions'>): RouteMount[] {
  return [{ dir: projectPaths(root, config).api, prefix: '' }, ...apiMounts(root, config.extensions)]
}

// Every module under `apiDir`, mounted at `/api` plus its path there, then each mounted library's under its prefix that no module before it is served at.
export async function scanApi(apiDir: string, mounts: RouteMount[] = []): Promise<ApiModule[]> {
  const trees = [{ dir: apiDir, prefix: '' }, ...mounts]
  const modules: ApiModule[] = []

  for (const [index, { dir, prefix }] of trees.entries()) {
    if (!existsSync(dir))
      continue

    const taken = new Set(modules.map(module => module.mount))

    for await (const path of new Bun.Glob('**/*.ts').scan({ cwd: dir })) {
      const name = path.split(sep).join('/')

      if (NOT_A_MODULE.test(name))
        continue

      if (ROUTER_SYNTAX.test(name))
        throw new Error(`kay: ${join(dir, path)} has a :, * or ' in its path, which the router cannot mount; rename it`)

      const mount = mountOf(prefix, name)
      const at = `${prefix}/${dirname(name)}`.replace(CURRENT_DIR, '')

      // The app's module, or an earlier library's, at the same path replaces a library's.
      if (index > 0 && taken.has(mount))
        continue

      const file = join(dir, path)
      const open = falseKeys(await Bun.file(file).text(), API_OPTIONS).has('guards')

      modules.push({ file, mount, guards: open ? [] : guardsAt(trees, at), ...(open || index > 0) && { open: true } })
    }
  }

  // By UTF-16 code unit, as every machine orders them alike.
  return modules.sort((a, b) => a.file < b.file ? -1 : Number(a.file > b.file))
}

// The guards every module runs, the API directory's own first; with none of its own, those of a directory holding every module. A module setting `guards: false` runs none and leaves them as they are.
export function sharedGuards(modules: ApiModule[]): string[] {
  const [first, ...rest] = modules.filter(module => module.open !== true || module.guards.length > 0)
  const shared: string[] = []

  for (const [index, guard] of first?.guards.entries() ?? []) {
    if (!rest.every(module => module.guards[index]?.file === guard.file))
      break

    shared.push(guard.file)
  }

  return shared
}

// Where a module at `name` in a tree mounted at `prefix` is served: `/api/auth/session` for `session.ts` under `/auth`.
function mountOf(prefix: string, name: string): string {
  return `${API_PREFIX}${`${prefix}/${name.replace(TS_FILE, '').replace(INDEX, '')}`.replace(TRAILING_SLASH, '')}`
}

// The guards of a directory of the API tree and above, `''` for its root, outermost first: the app's at each level, else a library's.
function guardsAt(trees: RouteMount[], at: string): ApiGuard[] {
  return directoriesUp(at).flatMap((dir) => {
    const file = fileAt(trees, dir, GUARD)

    return file === undefined ? [] : [{ file, path: `${dir}/${GUARD}`.slice(1) }]
  }).reverse()
}

// The span of each API request in flight.
const spans = new WeakMap<Request, Span>()

// Mounts each module's default export, an Elysia instance, under its path: its guards run first, then a websocket upgrade or an unsafe request from another site is refused, unless the module's `cors` lets that site in.
// Gives back the body limit of each module by the path it is mounted at, and the modules as mounted.
export async function serveApi(app: Elysia, modules: ApiModule[], options: ActionOptions): Promise<{ limits: Map<string, BodyLimit>, mounted: MountedApi[] }> {
  const limits = new Map<string, BodyLimit>()
  const mounted: MountedApi[] = []

  // Global: a group's own afterResponse hook never runs once the app holds a global one, as the request log does.
  app.onAfterResponse({ as: 'global' }, ({ request, set, responseValue }) => {
    const span = spans.get(request)

    if (!span)
      return

    spans.delete(request)
    answered(span, responseValue instanceof Response ? responseValue.status : typeof set.status === 'number' ? set.status : 200)
    span.end()
  })

  for (const module of modules) {
    const instance = (await importModule<{ default?: unknown }>(module.file)).default

    if (!(instance instanceof Elysia))
      throw new TypeError(`kay: ${module.file} must export an Elysia instance by default: export default new Elysia().get('/', () => ...)`)

    Object.defineProperty(instance, API_MOUNT, { value: module.mount, configurable: true })
    mounted.push({ ...module, instance })
    const cors = (instance as { [CORS]?: CorsRule })[CORS]

    limits.set(module.mount, { bytes: (instance as { [BODY_LIMIT]?: number })[BODY_LIMIT], refuse: cors ? request => corsResponse(cors, request, tooLarge()) : tooLarge })

    const guards = requiredGuards(await Promise.all(module.guards.map(async ({ file }) => loadGuard({ file, special: {} }))), module, {}, options.requireGuards)
    const methods = [...new Set(instance.routes.map(route => route.method.toUpperCase()).filter(method => method !== 'OPTIONS' && method !== 'WS'))]

    app.group(module.mount, (group) => {
      // Registered before the hooks, so a preflight, which carries no credentials, never meets the guards.
      if (cors)
        group.options('/', ({ request }) => preflight(cors, methods, request)).options('/*', ({ request }) => preflight(cors, methods, request))

      return group
        // A span from the guards to the response, which the handler's own spans do not nest under: the handler runs in Elysia's call, not in one kay makes.
        .onBeforeHandle(({ request, route: mounted }) => {
          // `/api/echo` rather than the `/api/echo/` a module's `/` route is mounted at.
          const route = mounted.length > 1 ? mounted.replace(TRAILING_SLASH, '') : mounted
          const span = startSpan(`${request.method} ${route}`, { kind: SERVER_SPAN, attributes: { 'http.request.method': request.method, 'http.route': route, 'url.path': requestUrl(request).pathname, 'kay.request.id': requestId(request) } })

          if (span)
            spans.set(request, span)
        })
        // A route of the module's own answering OPTIONS, `.all()` included, leaves a browser's preflight to kay.
        .onBeforeHandle(({ request }) => cors && request.method === 'OPTIONS' && request.headers.has('access-control-request-method') ? preflight(cors, methods, request) : undefined)
        // The guards are kay's call, so what they log carries the request; the handler runs in Elysia's.
        // With no guard and no cors rule nothing runs in the request's scope, so only the cross-site check is left.
        .onBeforeHandle(async (context) => {
          if (guards.length === 0 && !cors)
            return crossSiteRefused(context.request) ? new Response('Cross-site request refused', { status: 403 }) : undefined

          return answeringRequest(context.request, async () => inLocale(context.request, options, async () => admit(guards, sharedContext(context.request, () => ({ ...context })), options, cors)))
        })
        .mapResponse(({ responseValue, set }) => withBigints(sendable(responseValue), set))
        .onError(({ request, error, set }) => {
          const span = spans.get(request)

          // Input refused before the guards ran gets the headers too, so the calling page can read why.
          if (cors)
            withCors(cors, request, set.headers)

          if (span)
            failed(span, error)
        })
        // Before the module's own `onError`, so no custom answer to refused input reaches a caller the guards refuse.
        .onError(async (context) => {
          // Past the guards, a failing response schema or a handler's own throw is no input to keep from a refused caller.
          if ((context.code !== 'VALIDATION' && context.code !== 'INVALID_FILE_TYPE') || guards.length === 0 || admitted.has(context.request))
            return undefined

          const refusal = await answeringRequest(context.request, async () => inLocale(context.request, options, async () => guardsFirst(guards, sharedContext(context.request, () => ({ ...context })), (context as { params?: Record<string, unknown> }).params ?? {}, undefined, options)))

          if (refusal && cors)
            withCors(cors, context.request, refusal.headers)

          return refusal
        })
        .onAfterHandle(({ request, responseValue, set }) => {
          // A Vary the route set itself keeps Origin.
          if (cors)
            withCors(cors, request, responseValue instanceof Response ? responseValue.headers : set.headers)

          const reporter = responseValue instanceof Response ? streamReporters.get(responseValue) : undefined

          if (reporter)
            reporter.report = error => reportServerError(error, request, options.onError)
        })
        .use(instance)
        // After the module's own `onError`, which may answer the error itself.
        .onError(({ request, error, code, set }) => reportThrown({ request, error, code, set }, options))
    })
  }

  return { limits, mounted }
}

// Logs an error a route threw and hands it to `onError`, keeping its message out of a production answer, where Elysia would send it.
// Refused input, an unknown route or a status the handler threw are answered as Elysia means them.
function reportThrown({ request, error, code, set }: { request: Request, error: unknown, code: unknown, set: { status?: number | string, headers: Record<string, unknown> } }, options: ActionOptions): string | undefined {
  if (code !== 'UNKNOWN' && code !== 'INTERNAL_SERVER_ERROR')
    return undefined

  reportServerError(error, request, options.onError)

  if (options.dev)
    return undefined

  set.status = 500
  set.headers['content-type'] = TEXT['content-type']

  return 'Internal Server Error'
}

// A class instance or a Map, which Elysia would answer as `200 [object Object]`, is a mistake in the route: thrown, so it is logged and answers 500. A `status()` answer's body is checked the same way.
function sendable(value: unknown): unknown {
  if (value instanceof ElysiaCustomStatusResponse) {
    sendable(value.response)

    return value
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || (value).toString !== Object.prototype.toString || sentAsIs(value))
    return value

  throw new TypeError(`kay: an API route answered a ${value.constructor?.name ?? 'value'}, which would reach the client as "${Object.prototype.toString.call(value)}": answer a plain object or array, or a Response`)
}

// Bodies Elysia or `Response` send as they are, though they write as `[object ...]`.
function sentAsIs(value: object): boolean {
  if (value instanceof Response || value instanceof Blob || value instanceof FormData || value instanceof ReadableStream || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer || ArrayBuffer.isView(value))
    return true

  if (value instanceof ElysiaFile || value instanceof Cookie)
    return true

  return STREAMED.some(method => typeof (value as Record<string, unknown>)[method] === 'function')
}

// JSON has no bigint, which JSON.stringify throws on: a plain object or array holding one is answered with each written as its digits, as a database's bigint ids usually are.
function withBigints(value: unknown, set: { status?: number | string, headers: Record<string, unknown> }): Response | undefined {
  if (typeof value !== 'object' || value === null || (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) || stringifies(value) || !holdsBigint(value))
    return undefined

  const headers = new Headers()

  // Several cookies stay several headers.
  for (const [name, header] of Object.entries(set.headers)) {
    for (const item of [header].flat())
      headers.append(name, String(item))
  }

  headers.set('content-type', 'application/json')

  return new Response(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item), { status: typeof set.status === 'number' ? set.status : 200, headers })
}

// Whether JSON.stringify takes the value as it is, which is how nearly every reply goes: cheaper than walking it for a bigint, and what throws, a bigint or a cycle, is walked after.
function stringifies(value: object): boolean {
  try {
    JSON.stringify(value)

    return true
  }
  catch {
    return false
  }
}

// A value met twice is walked once, so a cycle reaches JSON.stringify, which names it.
function holdsBigint(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'bigint')
    return true

  if (typeof value !== 'object' || value === null || seen.has(value))
    return false

  seen.add(value)

  return Object.values(value).some(item => holdsBigint(item, seen))
}

function tooLarge(): Response {
  return new Response('Request body too large', { status: 413, headers: TEXT })
}

// Guards first, so a request without credentials gets their answer whatever its origin; what they set on the response goes out with the route's.
// They read the params of the module's route the request matched.
async function admit(guards: LoadedGuard[], context: { request: Request, params?: Record<string, unknown>, set: { headers: Record<string, unknown> } }, options: ActionOptions, cors: CorsRule | undefined): Promise<Response | undefined> {
  if (cors)
    withCors(cors, context.request, context.set.headers)

  // Before the guards, so a library reading the session for them, such as kayjs-auth, knows the origin is let in.
  if (cors && corsAdmits(cors, context.request))
    admitCrossSite(context.request)

  const passed = guards.length > 0 ? await passGuards(guards, context, context.params ?? {}, options) : undefined

  if (passed instanceof Response)
    return passed

  if (passed)
    admitted.add(context.request)

  // A browser lets any page open a websocket or post a form to any host, the user's cookies attached; a request with neither header, such as a webhook, is no browser's.
  if (crossSiteRefused(context.request))
    return new Response('Cross-site request refused', { status: 403 })

  if (!passed)
    return undefined

  const { headers } = context.set

  const cookies = new Headers()

  for (const [name, value] of passed.headers) {
    if (name === 'set-cookie')
      cookies.append(name, value)
    else
      headers[name] = value
  }

  passed.jar.writeTo(cookies)

  if (cookies.getSetCookie().length > 0)
    headers['set-cookie'] = [...[headers['set-cookie'] ?? []].flat(), ...cookies.getSetCookie()]

  return undefined
}

// Mapped, so the locals read as the record Elysia's context takes, nothing registered included.
type ApiLocals = { [Key in keyof Locals]: Locals[Key] }
type Empty = Record<never, never>

export interface ApiOptions {
  // The most bytes a request to the module's routes may send, in place of the app's `bodyLimit`.
  bodyLimit?: number | undefined
  // Lets other sites' pages call the module's routes from the browser: `cors: { origins: ['https://app.example.com'], credentials: true }`.
  cors?: CorsOptions | undefined
  // Runs none of the guards above the module, as a page's `guards: false` does; read from the `api({ guards: false })` call as written.
  guards?: false | undefined
}

// An Elysia instance for a module under `src/api` whose handlers read what the app's `derive` and `resolve` add, typed through `Register` as `ctx.locals` is.
export function api(options: ApiOptions = {}): Elysia<'', { decorator: Empty, store: Empty, derive: Empty, resolve: ApiLocals }> {
  const instance = new Elysia()

  if (options.bodyLimit !== undefined)
    Object.defineProperty(instance, BODY_LIMIT, { value: options.bodyLimit })

  if (options.cors !== undefined)
    Object.defineProperty(instance, CORS, { value: corsRule(options.cors) })

  return instance as unknown as Elysia<'', { decorator: Empty, store: Empty, derive: Empty, resolve: ApiLocals }>
}

// Answers with a server-sent event per value `source` gives, which `stream()` reads typed in an island: values cross as island props do, Dates, Maps and Sets included.
// The source is read one value per value the browser takes, and stopped when it goes away; a source that throws ends the stream as failed, the error logged.
export function eventStream<T>(source: AsyncIterable<T> | Iterable<T>): EventStream<T> {
  let iterator: AsyncIterator<T> | Iterator<T> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let cancelled = false
  const encoder = new TextEncoder()
  const reporter = { report: (error: unknown) => kayLog('error', 'an event stream failed', error) }

  const finish = (controller: ReadableStreamDefaultController<Uint8Array>, event: string) => {
    clearInterval(heartbeat)
    controller.enqueue(encoder.encode(`event: ${event}\ndata:\n\n`))
    controller.close()
  }

  const response = new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!iterator) {
        iterator = Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]()
        heartbeat = setInterval(() => controller.enqueue(HEARTBEAT), HEARTBEAT_MS)
      }

      try {
        const next = await iterator.next()

        if (cancelled)
          return

        if (next.done)
          finish(controller, END_EVENT)
        else
          controller.enqueue(encoder.encode(`data: ${encodeEvent(next.value)}\n\n`))
      }
      catch (error) {
        if (cancelled)
          return

        reporter.report(error)
        void iterator.return?.()
        finish(controller, ERROR_EVENT)
      }
    },
    // Not awaited: an async generator waiting on its next value only returns once it has one, which a quiet feed may never give.
    cancel() {
      cancelled = true
      clearInterval(heartbeat)
      void iterator?.return?.()
    },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' } })

  streamReporters.set(response, reporter)

  return response as EventStream<T>
}

function encodeEvent(value: unknown): string {
  try {
    return encodeValue(value)
  }
  catch (error) {
    const reason = unsendable(error)

    throw reason === undefined ? error : new TypeError(`kay: a value the event stream sent cannot reach the browser: ${reason}`)
  }
}

// In the browser build an island imports a module of one of the API `trees` for its routes' types only: it gets where they are served, and none of the server code.
// A library module the app replaced gives the app's mount, which is the same path, so a library island importing it still builds.
export function apiStubs(trees: RouteMount[]): BunPlugin {
  // A tree reached through a link, a library linked into the app, is matched by its real path too, which Bun hands for a module imported from the real side.
  const reached = trees.flatMap(tree => [...new Set([tree.dir, existsSync(tree.dir) ? realpathSync(tree.dir) : tree.dir])].map(dir => ({ dir, prefix: tree.prefix })))

  return {
    name: 'kay-api',
    setup(build) {
      build.onLoad({ filter: new RegExp(`^(?:${reached.map(({ dir }) => (dir + sep).replace(REGEX_SYNTAX, '\\$&')).join('|')}).*\\.ts$`) }, ({ path }) => {
        const { dir, prefix } = reached.find(tree => path.startsWith(tree.dir + sep))!
        const name = relative(dir, path).split(sep).join('/')

        if (NOT_A_MODULE.test(name))
          throw new Error(`kay: an island imports ${name}, which is no module under ${basename(dir)}: only a module's default export reaches the browser, as where its routes are served`)

        return { contents: `export default { [Symbol.for('kay.api')]: ${JSON.stringify(mountOf(prefix, name))} }`, loader: 'js' }
      })
    },
  }
}
