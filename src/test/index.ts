import type { AnyElysia } from 'elysia'
import type { Action, ResultOf, Success } from '../runtime/action'
import type { EventReader, NodeAt, Optional, SocketOf, SocketOptions, SocketPath, StreamMethod, StreamOf, StreamOptions, StreamPath } from '../runtime/live'
import type { PagesOptions } from '../server/app'
import type { ClientBuild } from '../server/client'
import type { BrowserOptions, TestPage } from './browser'
import type { PageReading } from './page'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import { buildClient } from '../build/client'
import { withConfig } from '../config'
import { encodeCall, readActionResponse } from '../runtime/action'
import { openSocket, readEvents, routeUrl, streamRequest } from '../runtime/live'
import { effect, root as reactiveRoot } from '../runtime/reactive'
import { servePages } from '../server/app'
import { basePath } from '../server/base'
import { shutdown } from '../server/lifecycle'
import { drainQueues } from '../server/queue'
import { SITEMAP } from '../server/sitemap'
import { servedThrough } from '../server/visit'
import { browse } from './browser'
import { readPage, sitemapUrls } from './page'
import { testRoot } from './root'

export type { BrowserOptions, TestPage, WaitForOptions, WaitOptions } from './browser'
export { browse, browserPath } from './browser'
export type { Mounted } from './mount'
export { mount, settle } from './mount'
export type { Found, PageReading } from './page'

export interface TestOptions extends PagesOptions {
  // The plugins the server entry uses before the pages, in order, such as `session()`: their derives reach `ctx.locals` and their cookies the next request.
  use?: AnyElysia[]
  // What the app's Elysia `derive` would add for a request, such as the signed-in user, read by pages, guards and actions as `ctx.locals`.
  locals?: (request: Request) => Record<string, unknown> | Promise<Record<string, unknown>>
  // Builds the islands for the browser, as `kay dev` does into `.kay/client`, for `open()` to load pages in a headless Chrome.
  browser?: boolean | BrowserOptions
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

type InputOf<Target> = Target extends Action<infer Input, unknown> ? Input : never

export interface TestSite {
  // A GET as a browser makes it: earlier cookies sent, redirects followed.
  visit: (path: string, init?: VisitInit) => Promise<Visit>
  // A plain form post from the page at `from`, multipart as kay's forms send it, followed back to wherever the action sends the browser.
  submit: <Input, Honeypot extends string = never>(action: Action<Input, unknown, Honeypot>, fields: Partial<Record<Extract<keyof Input, string> | Honeypot, FormValue | FormValue[] | undefined>>, init?: VisitInit & { from?: string }) => Promise<Visit>
  // The call an island makes, with its input or a form's fields: the result, an `ActionError` thrown, or an `ActionRedirect` when it redirects.
  call: <Target extends Action<never, unknown>>(action: Target, input: InputOf<Target> | FormData, init?: VisitInit) => Promise<Success<ResultOf<Target>>>
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
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket
const MAX_REDIRECTS = 10

// The project's pages and actions without a server, and without a browser build unless `browser` is set: pages then render their islands' markup and no scripts.
export async function testSite(options: TestOptions = {}): Promise<TestSite> {
  const root = testRoot(options.root)
  const config = await withConfig(root, options)
  const client: ClientBuild = options.browser !== undefined && options.browser !== false
    ? await buildClient(root, { plugins: config.plugins, routes: config.routes, api: config.api, navigation: config.navigation, base: basePath(config.base), settings: config.settings, publicEnv: config.publicEnv !== undefined })
    : { entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: join(root, '.kay', 'client', 'dist') }
  const browser = typeof options.browser === 'object' ? options.browser : {}
  const pages = await servePages(root, config, async () => client)
  const locals = options.locals
  const before = [...options.use ?? [], ...locals ? [new Elysia().derive({ as: 'global' }, async ({ request }) => locals(request))] : []]
  const app = before.length === 0 ? pages : before.reduce<AnyElysia>((served, plugin) => served.use(plugin), new Elysia()).use(pages)
  const cookies = new Bun.CookieMap()

  const cookieHeader = (headers: Headers) => {
    const sent = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')

    if (sent !== '')
      headers.set('cookie', sent)

    return headers
  }

  // What kay sends through the app on the visitor's behalf, as the page a refused post renders, goes through all of it, as a server would send it.
  const handle = async (request: Request): Promise<Response> => {
    servedThrough(request, handle)

    return app.handle(request)
  }

  const send = async (path: string, init: Omit<RequestInit, 'headers'> & VisitInit): Promise<Response> => {
    const headers = cookieHeader(new Headers(init.headers))

    const response = await handle(new Request(new URL(path, ORIGIN), { ...init, headers, redirect: 'manual' }))

    for (const header of response.headers.getSetCookie()) {
      const cookie = Bun.Cookie.parse(header)

      if (cookie.isExpired())
        cookies.delete(cookie.name)
      else
        cookies.set(cookie)
    }

    return response
  }

  const follow = async (response: Response, url: string, headers?: Record<string, string>): Promise<Visit> => {
    let current = response
    let path = url

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

    const html = await current.text()

    return { url: path, status: current.status, headers: current.headers, html, ...readPage(html) }
  }

  let server: Bun.Server<unknown> | undefined
  const opened = new Set<TestPage>()

  const listening = (): Bun.Server<unknown> => {
    if (!server) {
      app.listen({ port: 0, hostname: 'localhost' })
      server = app.server!
      server.unref()
    }

    return server
  }

  return {
    cookies,
    handle,
    runJobs: drainQueues,
    sitemap: async (path = SITEMAP) => {
      const response = await send(path, {})

      if (response.status !== 200)
        throw new Error(`kay: ${path} answered ${response.status}`)

      return sitemapUrls(await response.text())
    },
    fetch: async (path, init = {}) => send(path, init),
    socket: (module, path, ...[options]) => {
      const url = routeUrl(module, path, options as Parameters<typeof routeUrl>[2])
      const client = openSocket(() => new BunWebSocket(`ws://localhost:${listening().port}${url}`, { headers: Object.fromEntries(cookieHeader(new Headers(options?.headers))) }))
      const tested = Object.assign(client, inbox(client))

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
      reader.start()

      return tested as never
    },
    open: async (path, browserOptions) => {
      if (options.browser === undefined || options.browser === false)
        throw new Error('kay: open() loads pages in a browser, which needs their islands built: testSite({ browser: true })')

      const page = await browse(new URL(path, `http://localhost:${listening().port}`).href, { ...browser, ...browserOptions })
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

      if (server)
        await shutdown(app)

      server = undefined
    },
    visit: async (path, init = {}) => follow(await send(path, { headers: init.headers }), path, init.headers),
    submit: async (action, fields, init = {}) => {
      const from = init.from ?? '/'
      const form = new FormData()

      for (const [name, value] of Object.entries(fields as Record<string, FormValue | FormValue[] | undefined>)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined)
            form.append(name, item)
        }
      }

      const response = await send(action.url, {
        method: 'POST',
        headers: { origin: ORIGIN, referer: new URL(from, ORIGIN).href, ...init.headers },
        body: form,
      })

      return follow(response, from, init.headers)
    },
    call: async (action, input, init = {}) => {
      const { headers, body } = encodeCall(input)

      return readActionResponse<Success<ResultOf<typeof action>>>(await send(action.url, { method: 'POST', headers: { ...headers, origin: ORIGIN, ...init.headers }, body }))
    },
  }
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
