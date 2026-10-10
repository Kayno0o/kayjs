import type { BunPlugin } from 'bun'
import type { Locals } from '../runtime'
import type { EventStream } from '../runtime/live'
import type { ActionOptions } from './actions'
import type { BodyLimit } from './body'
import type { LoadedGuard } from './guards'
import type { Span } from './trace'
import { existsSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { Elysia } from 'elysia'
import { logError } from '../build/sourcemap'
import { API_MOUNT, END_EVENT, ERROR_EVENT } from '../runtime/live'
import { encodeValue, unsendable } from '../runtime/wire'
import { inLocale, isCrossSite, passGuards } from './actions'
import { importModule } from './bundle'
import { loadGuard } from './guards'
import { reportServerError } from './report'
import { answered, failed, SERVER_SPAN, startSpan } from './trace'

// A module under the API directory, as `pages()` mounts it.
export interface ApiModule {
  file: string
  // Where its routes are served: `/api/chat` for `src/api/chat.ts`, `/api` for `src/api/index.ts`.
  mount: string
  // The `_guard.ts` files of its directory and above, outermost first.
  guards: string[]
}

export const API_PREFIX = '/api'
const GUARD = '_guard.ts'
// Tests, declarations, and files or directories starting with `_`, guards and helpers, are no modules.
const NOT_A_MODULE = /(?:^|\/)_|\.(?:test|spec|d)\.ts$/
const TS_FILE = /\.ts$/
const INDEX = /(?:^|\/)index$/
// What Elysia reads as a parameter or a wildcard, or breaks the code it generates on, in a mount path.
const ROUTER_SYNTAX = /[:*']/
// Bun closes a connection idle for 10 s by default, and proxies after a minute or so: a comment line now and then keeps a quiet stream open.
const HEARTBEAT_MS = 5000
const HEARTBEAT = new TextEncoder().encode(':\n\n')
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/g
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
// Where `api({ bodyLimit })` keeps its limit on the instance it makes.
const BODY_LIMIT = Symbol.for('kay.bodyLimit')

// Where a failing event stream reports its error: logged, and handed to `onError` once the route answering with it is known.
const streamReporters = new WeakMap<Response, { report: (error: unknown) => void }>()

// Every module under `apiDir`, mounted at `/api` plus its path there.
export async function scanApi(apiDir: string): Promise<ApiModule[]> {
  if (!existsSync(apiDir))
    return []

  const modules: ApiModule[] = []

  for await (const path of new Bun.Glob('**/*.ts').scan({ cwd: apiDir })) {
    const name = path.split(sep).join('/')

    if (NOT_A_MODULE.test(name))
      continue

    if (ROUTER_SYNTAX.test(name))
      throw new Error(`kay: ${join(apiDir, path)} has a :, * or ' in its path, which the router cannot mount; rename it`)

    const route = name.replace(TS_FILE, '').replace(INDEX, '')
    const file = join(apiDir, path)

    modules.push({ file, mount: route === '' ? API_PREFIX : `${API_PREFIX}/${route}`, guards: guardsOf(apiDir, dirname(file)) })
  }

  return modules.sort((a, b) => a.file.localeCompare(b.file))
}

function guardsOf(apiDir: string, dir: string): string[] {
  const guards: string[] = []

  for (let current = dir; current.startsWith(apiDir); current = dirname(current)) {
    if (existsSync(join(current, GUARD)))
      guards.unshift(join(current, GUARD))

    if (current === apiDir)
      break
  }

  return guards
}

const TRAILING_SLASH = /\/$/
// The span of each API request in flight.
const spans = new WeakMap<Request, Span>()

// Mounts each module's default export, an Elysia instance, under its path: its guards run first, then a websocket upgrade or an unsafe request from another site is refused.
// Gives back the body limit of each module by the path it is mounted at.
export async function serveApi(app: Elysia, modules: ApiModule[], options: ActionOptions): Promise<Map<string, BodyLimit>> {
  const limits = new Map<string, BodyLimit>()

  for (const module of modules) {
    const instance = (await importModule<{ default?: unknown }>(module.file)).default

    if (!(instance instanceof Elysia))
      throw new TypeError(`kay: ${module.file} must export an Elysia instance by default: export default new Elysia().get('/', () => ...)`)

    Object.defineProperty(instance, API_MOUNT, { value: module.mount, configurable: true })
    limits.set(module.mount, { bytes: (instance as { [BODY_LIMIT]?: number })[BODY_LIMIT], refuse: tooLarge })

    const guards = await Promise.all(module.guards.map(async file => loadGuard({ file, special: {} })))

    app.group(module.mount, group => group
      // A span from the guards to the response, which the handler's own spans do not nest under: the handler runs in Elysia's call, not in one kay makes.
      .onBeforeHandle(({ request, route: mounted }) => {
        // `/api/echo` rather than the `/api/echo/` a module's `/` route is mounted at.
        const route = mounted.length > 1 ? mounted.replace(TRAILING_SLASH, '') : mounted
        const span = startSpan(`${request.method} ${route}`, { kind: SERVER_SPAN, attributes: { 'http.request.method': request.method, 'http.route': route, 'url.path': new URL(request.url).pathname } })

        if (span)
          spans.set(request, span)
      })
      .onBeforeHandle(async context => inLocale(context.request, options, async () => admit(guards, context, options)))
      .mapResponse(({ responseValue, set }) => withBigints(responseValue, set))
      .onError(({ request, error }) => {
        const span = spans.get(request)

        if (span)
          failed(span, error)
      })
      .onAfterResponse(({ request, set, responseValue }) => {
        const span = spans.get(request)

        if (!span)
          return

        spans.delete(request)
        answered(span, responseValue instanceof Response ? responseValue.status : typeof set.status === 'number' ? set.status : 200)
        span.end()
      })
      .onAfterHandle(({ request, responseValue }) => {
        const reporter = responseValue instanceof Response ? streamReporters.get(responseValue) : undefined

        if (reporter)
          reporter.report = error => reportServerError(error, request, options.onError)
      })
      .use(instance))
  }

  return limits
}

// JSON has no bigint, which JSON.stringify throws on: a plain object or array holding one is answered with each written as its digits, as a database's bigint ids usually are.
function withBigints(value: unknown, set: { status?: number | string, headers: Record<string, unknown> }): Response | undefined {
  if (typeof value !== 'object' || value === null || (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) || !holdsBigint(value))
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
async function admit(guards: LoadedGuard[], context: { request: Request, params?: Record<string, unknown>, set: { headers: Record<string, unknown> } }, options: ActionOptions): Promise<Response | undefined> {
  const passed = guards.length > 0 ? await passGuards(guards, context, context.params ?? {}, options) : undefined

  if (passed instanceof Response)
    return passed

  // A browser lets any page open a websocket or post a form to any host, the user's cookies attached; a request with neither header, such as a webhook, is no browser's.
  if ((!SAFE_METHODS.has(context.request.method) || context.request.headers.get('upgrade')?.toLowerCase() === 'websocket') && isCrossSite(context.request))
    return new Response('Cross-site request refused', { status: 403 })

  if (!passed)
    return undefined

  const { headers } = context.set

  for (const [name, value] of passed.headers)
    headers[name] = value

  const cookies = new Headers()

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
}

// An Elysia instance for a module under `src/api` whose handlers read what the app's `derive` and `resolve` add, typed through `Register` as `ctx.locals` is.
export function api(options: ApiOptions = {}): Elysia<'', { decorator: Empty, store: Empty, derive: Empty, resolve: ApiLocals }> {
  const instance = new Elysia()

  if (options.bodyLimit !== undefined)
    Object.defineProperty(instance, BODY_LIMIT, { value: options.bodyLimit })

  return instance as unknown as Elysia<'', { decorator: Empty, store: Empty, derive: Empty, resolve: ApiLocals }>
}

// Answers with a server-sent event per value `source` gives, which `stream()` reads typed in an island: values cross as island props do, Dates, Maps and Sets included.
// The source is read one value per value the browser takes, and stopped when it goes away; a source that throws ends the stream as failed, the error logged.
export function eventStream<T>(source: AsyncIterable<T> | Iterable<T>): EventStream<T> {
  let iterator: AsyncIterator<T> | Iterator<T> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let cancelled = false
  const encoder = new TextEncoder()
  const reporter = { report: logError }

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

// In the browser build an island imports a module under `apiDir` for its routes' types only: it gets where they are served, and none of the server code.
export function apiStubs(apiDir: string, modules: ApiModule[]): BunPlugin {
  const mounts = new Map(modules.map(module => [module.file, module.mount]))

  return {
    name: 'kay-api',
    setup(build) {
      build.onLoad({ filter: new RegExp(`^${(apiDir + sep).replace(REGEX_SYNTAX, '\\$&')}.*\\.ts$`) }, ({ path }) => {
        const mount = mounts.get(path)

        if (mount === undefined)
          throw new Error(`kay: an island imports ${relative(apiDir, path)}, which is no module under ${basename(apiDir)}: only a module's default export reaches the browser, as where its routes are served`)

        return { contents: `export default { [Symbol.for('kay.api')]: ${JSON.stringify(mount)} }`, loader: 'js' }
      })
    },
  }
}
