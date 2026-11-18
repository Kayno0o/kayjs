import type { SignedIn, SignInFields } from '.'
import type { Action, ActionError, FailuresOf, FORM_FIELD, NoInputAction, ResultOf, STAMP_FIELD, Success } from '../runtime/action'
import type { Duration } from '../runtime/duration'
import type { ApiAnswer, ApiRequest, CallMethod, CallPath, NodeAt, Optional, SocketOf, SocketOptions, SocketPath, StreamMethod, StreamOf, StreamOptions, StreamPath } from '../runtime/live'
import type { PagesOptions } from '../server/app'
import type { ScheduleJob } from '../server/jobs'
import type { LogEntry } from '../server/log'
import type { PluginInput } from '../server/plugin'
import type { TestContent } from './content'
import type { FetchStub, FetchStubRoutes } from './outgoing'
import type { PageReading } from './page'
import type { A11yViolation, BrowserOptions, TestPage } from './page-types'

export interface SignInHook {
  // The library, such as `auth`: a second hook of the same name replaces the first, so `test(site)` called in each test joins once.
  name: string
  signIn: (who: SignInFields) => Promise<Partial<SignedIn> | undefined>
  signOut: () => void
}

export interface TestOptions extends PagesOptions {
  // Whether a call to another host that no `site.fetchStub` answers fails (`'fail'`, the default) or goes to the network (`'allow'`); a call to loopback, such as a `fakeService`, always goes through.
  outgoing?: 'fail' | 'allow' | undefined
  // Headers every request of the site sends unless the call gives one of the same name, such as an `authorization` bearer token; `site.as()` adds to them.
  headers?: Record<string, string> | undefined
  // The plugins the server entry uses before the pages, in order, such as `session()`: their derives reach `ctx.locals` and their cookies the next request.
  use?: PluginInput[] | undefined
  // What the app's Elysia `derive` would add for a request, such as the signed-in user, read by pages, guards and actions as `ctx.locals`.
  locals?: ((request: Request) => Record<string, unknown> | Promise<Record<string, unknown>>) | undefined
  // Loads pages in a headless Chrome with `open()`, served from the islands built for the browser.
  browser?: boolean | BrowserOptions | undefined
  // Builds the islands for the browser, unminified, into `.kay/test-client`, or `.kay/client` with `browser`, so one a browser cannot build, such as a server module reaching it, fails `testSite()` here and not only under `kay dev`; no browser needed. On unless `false`, built again only when the files it read or the project's sources change, once for the files of a run.
  islands?: boolean | undefined
  // Builds the client for real, as `kay build` does and without Chrome: pages link the stylesheets the app's Tailwind builds and its island bundles, `site.fetch` answers them and `visit.css()` reads them. Off by default, as it loads Tailwind's native addon and builds into `.kay/client`; on with `browser`.
  styles?: boolean | undefined
}

// The page, with its head and its elements read from `html`.
export interface Visit extends PageReading {
  // Where the last redirect led, path and query.
  url: string
  status: number
  headers: Headers
  html: string
  // The page as the visitor ends up seeing it: each streamed `await` block replaced by its last part, read as the page is, and its `html` without the templates and the swap script.
  settled: PageReading & { html: string }
  // The CSS the page carries: its inline `<style>` blocks and every stylesheet it links, fetched from the site, as the app builds it. Needs `testSite({ styles: true })` or `browser`, else it throws.
  css: () => Promise<string>
  // The stamp the form posting to `action` rendered with, which `submit` takes as its `stamp`; `undefined` for a page with no such form or a form with no stamp.
  stamp: (action: Pick<Action, 'url'>) => string | undefined
  // Checks the markup with axe-core in a document of its own, or only the elements `selector` matches, as `page.a11y()` of a browser page does: what it breaks, none when it passes. The page's scripts never run and what needs a browser's layout, such as colour contrast and target size, is left out; needs `axe-core` and `@happy-dom/global-registrator` installed.
  a11y: (selector?: string) => Promise<A11yViolation[]>
  // Compares the page's HTML, normalised, with the baseline `__html__/<test file>/<name>.html` beside the test file: comments (hydration markers) left out, the hash of each built file's name, nonces and the stamp of a `minTime` form replaced by a fixed word, one tag or run of text a line. The baseline is written when there is none, and rewritten when `KAY_UPDATE_SNAPSHOTS=1` is set; a CI run fails for a missing one.
  matchHtml: (name: string) => Promise<void>
}

export interface VisitInit {
  headers?: Record<string, string> | undefined
}

// A text field, or a file input's `File`.
export type FormValue = string | Blob

// What a call gives back: every value of a handler returning an async iterable, else what it returned.
export type Tested<Output> = Success<Output> extends infer Value ? Value extends AsyncIterable<infer Item> ? Item[] : Value : never

// What `site.api` resolves with: a refusal is data, so a test of one reads its status and body rather than catching.
export type ApiResult<Answer> = { ok: true, status: number, headers: Headers, body: Answer } | { ok: false, status: number, headers: Headers, body: unknown }

export type InputOf<Target> = Target extends Action<infer Input, unknown> ? Input : never
// A call to an action whose fields are all optional, or that takes none, may leave its input out.
export type CallArguments<Target> = object extends InputOf<Target> ? [input?: InputOf<Target> | FormData, init?: VisitInit & { from?: string }] : [input: InputOf<Target> | FormData, init?: VisitInit & { from?: string }]

// What `submit` takes besides the action and its fields.
export type SubmitInit = VisitInit & { from?: string | Visit, openedFor?: Duration | 0, stamp?: string | undefined }

export type OpenSocket = <Module, const Path extends SocketPath<Module>>(module: Module, path: Path, ...[options]: Optional<SocketOptions<Module, Path> & VisitInit>) => TestSocket<SocketOf<Module, Path>>

export type RefusedSocket = <Module, const Path extends SocketPath<Module>>(module: Module, path: Path, ...[options]: Optional<SocketOptions<Module, Path> & VisitInit>) => Promise<Response>

export interface TestSite {
  // A GET as a browser makes it: earlier cookies sent, redirects followed.
  visit: (path: string, init?: VisitInit) => Promise<Visit>
  // A plain form post from the page at `from`, multipart as kay's forms send it, followed back to wherever the action sends the browser. A `Visit` as `from` posts where its form does, with the stamp `minTime` reads, from the URL the browser shows it at, the action's own for a page a refused post answered.
  // A post to an action with `minTime` goes through as if its form had been open long enough; `openedFor` sends one as if open that long instead, `0` as if just opened, and `stamp` posts the stamp it is given as it is, such as the one `visit.stamp(action)` read or a forged one.
  submit: {
    // An action with no input takes `{}` or no fields at all, `site.submit(forget, {}, { from })`.
    <Honeypot extends string = never>(action: NoInputAction<unknown, Honeypot>, fields?: Partial<Record<Honeypot | typeof STAMP_FIELD | typeof FORM_FIELD, FormValue | FormValue[] | undefined>>, init?: SubmitInit): Promise<Visit>
    <Input, Honeypot extends string = never>(action: Action<Input, unknown, Honeypot>, fields: Partial<Record<Extract<keyof Input, string> | Honeypot | typeof STAMP_FIELD | typeof FORM_FIELD, FormValue | FormValue[] | undefined>>, init?: SubmitInit): Promise<Visit>
  }
  // The call an island makes, with its input or a form's fields: the result, an `ActionError` thrown, or an `ActionRedirectError` when it redirects. `from` names the page it is made on, whose params the action reads.
  // A handler returning an async iterable gives every value once the stream ended, and throws when it failed.
  call: <Target extends Action>(action: Target, ...call: CallArguments<Target>) => Promise<Tested<ResultOf<Target>>>
  // A call expected to be refused, as `call` makes it: the `ActionError` with its status, errors and typed data; one that went through fails the test, and any other error is thrown.
  expectRefused: <Target extends Action>(action: Target, input: InputOf<Target> | FormData, init?: VisitInit & { from?: string }) => Promise<ActionError<FailuresOf<Target>>>
  // The site's MCP endpoint, as an agent calls it: `mcp: true` serves it. Calls carry the cookies so far and the headers given, such as an `Authorization` bearer token.
  mcp: {
    // The tools `tools/list` gives.
    tools: (init?: VisitInit) => Promise<McpTool[]>
    // What `initialize` answers a client with: the server's `serverInfo` and the `instructions` set by `mcp: { instructions }`, undefined when none.
    initialize: (init?: VisitInit) => Promise<McpInitialize>
    // A call to the tool named `name`, which a model would make: its result, with `isError` set when the app refused it, and the HTTP `status` of the answer, 401 when a guard asked for a sign-in. A request the endpoint answers with a protocol error, such as an unknown tool, is thrown.
    call: (name: string, args?: object, init?: VisitInit) => Promise<McpCall>
  }
  // A request to any route, an API module's included, with the cookies so far; the response as it is, redirects not followed.
  fetch: (path: string, init?: Omit<RequestInit, 'headers'> & VisitInit) => Promise<Response>
  // A route of a module under `src/api`, called as `call()` calls it from an island, typed from the route: the path as the module writes it, `method` (GET unless named), `params`, `query` and `body`. Resolves with the status, headers and body, the body parsed as an island reads it, whatever the status.
  api: <Module, const Path extends CallPath<Module>, const M extends CallMethod<NodeAt<Module, Path>> = never>(module: Module, path: Path, ...[options]: Optional<ApiRequest<Module, Path, M> & VisitInit>) => Promise<ApiResult<ApiAnswer<Module, Path, M>>>
  // The same site with these headers added to every request, a string being a `Cookie` header such as `auth.sessionCookie` returns; the site it was made from is unchanged and shares its cookies.
  as: (who: string | Record<string, string>) => TestSite
  // A websocket route of a module under `src/api`, opened as an island opens it, over a server the site starts on a free port the first time; `close()` stops it.
  // `socket.refused(module, path, options)` is a route expected to refuse the upgrade, which it sends for real: the refusal as a response, such as a guard's 401 or the 403 of a cross-site `origin`; an upgrade that was accepted fails the test. `onError({ error })` and `onClose({ status: 'failed' })` of the options run with the refusal; there is no connection, so `onOpen` and `onData` never do.
  socket: OpenSocket & { refused: RefusedSocket }
  // A route of a module under `src/api` answering with `eventStream()`, read as an island reads it.
  stream: <Module, const Path extends StreamPath<Module>, const M extends StreamMethod<NodeAt<Module, Path>> = never>(module: Module, path: Path, ...[options]: Optional<StreamOptions<Module, Path, M> & VisitInit>) => TestStream<StreamOf<Module, Path, M>>
  // A page loaded in a headless Chrome over a server the site starts on a free port, once `browser` is set, under its `base` when it has one; its cookies are the browser's, not `cookies`.
  open: (path: string, options?: BrowserOptions) => Promise<TestPage>
  // The URLs the sitemap at `path` (default `/sitemap.xml`) lists, failing when it does not answer 200.
  sitemap: (path?: string) => Promise<string[]>
  // Runs every job the queues hold whose time has come, those the jobs enqueue included, until none is left; resolves with how many ran.
  runJobs: () => Promise<number>
  // Fires the `schedule()` jobs of the app once each, now, whatever their time: those given the schedule text (`'@hourly'`, `'30s'`) or the job function, or every one without an argument; waits for each run and resolves with how many it fired, failing when none matches. A run that throws is reported as in production, not thrown here.
  runSchedule: (which?: string | number | ScheduleJob) => Promise<number>
  // Moves the clock forward by a duration with `setSystemTime` from `bun:test`, firing each schedule at every instant it falls due on the way, in order with the clock at that instant, then runs the queue jobs now due; resolves with how many scheduled runs it fired. Sessions, rate-limit windows, caches and sleeps read the moved clock. Restore it with `setSystemTime()`.
  advance: (by: Duration | number) => Promise<number>
  // Signs the site in for every library whose `test(site)` joined it: kayjs-auth reads `email` or `username` (with the `createUser` fields and the app's user `data`), kayjs-cms a `role`, or none for a guard holding one password. A second call switches member. Answers what each library signed in as.
  signInAs: (who: SignInFields) => Promise<SignedIn>
  // Signs the site out of every library that joined it, its other cookies kept.
  signOut: () => void
  // What a library's `test(site)` calls to take part in `signInAs` and `signOut`: `signIn` answers undefined for a `who` it has nothing to do with.
  joinSignIn: (hook: SignInHook) => void
  // Stands in for the outside services the app calls with `fetch`, for the test: routes keyed by a URL pattern with `*` for any characters, `'https://api.x/*'`, led by a method for one verb (`'POST https://api.x/v1/orders'`), each a value (JSON, a string as text, a `Response` as it is) or a function of the request. A later stub wins over an earlier one; the stubs end with the test. A call to loopback goes through, any other `http` or `https` call no stub answers fails, unless `testSite({ outgoing: 'allow' })`. The answer lists the requests the stub received.
  fetchStub: (routes: FetchStubRoutes) => FetchStub
  // Freezes the clock at a date (now when left out), which `Date.now()`, sessions, rate-limit windows and cache ages read; `advance` moves it on from there. The real time comes back after the test, and with `close()`.
  freezeTime: (at?: Date | number | string) => Date
  cookies: Bun.CookieMap
  // What the server logged since the test began, in order: the messages kay and libraries wrote, a `logFrom('reply').info(...)` of the app's included (`{ type: 'message', level, from, message, request?, error? }`), and the request lines when the app's `log` option logs them. Emptied before each test of a site made at the top of a file or a describe. The log is the process's, so two sites open at once each hear the other's lines.
  logs: readonly LogEntry[]
  // The site's content, which a test works on apart from the project's: a folder collection moves to a copy as the first save or delete reaches it, so a CMS's save never reaches the real `src/content`.
  content: TestContent
  handle: (request: Request) => Promise<Response>
  // Closes the pages `open()` opened, the sockets and streams left open, and stops the server `open()` or `socket()` started, if any. The site is closed once the tests ran anyway, so a test calls it only to close sooner; calling it twice is harmless.
  close: () => Promise<void>
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpInitialize {
  serverInfo: { name: string, title: string, version: string }
  instructions: string | undefined
}

export interface McpCall {
  isError: boolean
  // The text a model reads, which is the answer's JSON for an action or an API route that returns some.
  text: string
  // The answer parsed, when it is an object.
  data: Record<string, unknown> | undefined
  status: number
}

export type Received<Client> = Client extends { onData: (listener: (event: { value: infer Value }) => void) => unknown } ? Value : never

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
