import type { BunPlugin } from 'bun'
import type { AnyElysia } from 'elysia'
import type { BudgetConfig } from './build/budget'
import type { Listed as RouteListing } from './commands/routes'
import type { LintLevels } from './compiler/lints'
import type { Highlighter, MarkdownPreprocess, MarkdownTransform } from './content/markdown'
import type { ActionHooks, ActionProtect, ProtectionMessages, RateLimit } from './runtime/action'
import type { ByteSize } from './runtime/byte-size'
import type { Duration } from './runtime/duration'
import type { HeadTag } from './runtime/head'
import type { GuardContext } from './runtime/index'
import type { Localized } from './runtime/localized'
import type { PreviewScope } from './runtime/preview'
import type { JsonLd } from './runtime/seo'
import type { McpConfig } from './server/api-modules'
import type { AppHooks } from './server/app-hooks'
import type { AppStore } from './server/app-store'
import type { CorsOptions } from './server/cors'
import type { EnvSchema } from './server/env'
import type { GuardOption } from './server/lazy-guard'

import type { LogEntry } from './server/log'
import type { OpenApiConfig } from './server/openapi'
import type { PageHook } from './server/page-hook'
import type { PluginInput } from './server/plugin'
import type { Redirects } from './server/redirects'
import type { Rewrite } from './server/rewrite'
import type { Secret } from './server/secret'
import type { Prefetch } from './server/speculation'
import type { TraceExtractor, Tracer } from './server/trace'

// What `kay.config.ts` exports by default; `pages()`, `kay build`, `kay dev` and `kay check` all read it.
export interface KayConfig extends AppHooks {
  // Where the project keeps its parts, relative to the root.
  dirs?: DirsConfig | undefined
  // What a request may carry.
  limits?: LimitsConfig | undefined
  // How the server answers: compression and the stop.
  serve?: ServeConfig | undefined
  // Where the app's API and kay's own features are served, in one place: `api` (`/api`), `openapi` (`/api/openapi.json`), `mcp` (`/_kay/mcp`), `health` (`/_kay/health`), `metrics` (`/_kay/metrics`) and `jobs` (`/_kay/jobs`). Every default but the API's sits under `/_kay`; the options of each feature stay in its own key.
  endpoints?: EndpointsConfig | undefined
  // What pages ship to the browser and how it behaves there: navigation, styles, typography, hydration, prefetching and Save-Data.
  client?: ClientConfig | undefined
  // The files the site serves besides its pages: `images`, `fonts`, `favicon`, `manifest` and `publicCache`.
  assets?: AssetsConfig | undefined
  // What an app runs the server by: `observe`, `health`, `metrics` and `jobs`.
  ops?: OpsConfig | undefined
  // What every action starts from: the `protect` checks, `maxSize` and `messages` an action's own options replace key by key, and the `beforeRun`, `onSuccess` and `onError` hooks, which run before the action's own.
  actions?: ActionsConfig | undefined

  minify?: boolean | undefined
  lang?: string | undefined
  // The origin the site is public at, `https://example.com`: canonical links, social URLs and the sitemap are built from it. `SITE_URL` when left out, so one build serves each host it is deployed to; a `site` written here wins over `SITE_URL`.
  site?: string | undefined
  seo?: SeoConfig | undefined
  // What `/robots.txt` says besides pointing at the sitemap, or `false` to serve none: `{ disallow: ['/admin'] }`. Needs `site`, as the sitemap does.
  robots?: RobotsConfig | boolean | undefined
  // How `/sitemap.xml` is kept, or `false` to serve none (and name none in `/robots.txt`).
  sitemap?: SitemapConfig | boolean | undefined
  // Tags every page's head carries, written as a `head` block compiles them: `[{ tag: 'script', props: { src: '/stats.js', defer: true } }]`, a tag's text as `props.children`. A layout or the page setting a tag of the same identity wins, and the content security policy lets their inline scripts and styles through.
  head?: (HeadTag & { children?: never })[] | undefined
  // The most a page may load, compressed: `{ js: '20kb', css: '10kb' }` for its scripts and stylesheets, `weight: '500kb'` for the whole page and `grade: 'C'` for the worst EcoIndex grade it may have. `kay build` reports each page over it with `over-budget`, naming the modules weighing most for `js` and `css`; a key left out sets no limit, and with none nothing is checked.
  budget?: BudgetConfig | undefined
  // The server entry, relative to the root, `src/server.ts` by default: what `kay dev`, `start`, `render`, `check` and `build` run and type against, unless `--entry` names another. With no file there, kay's own server of the pages.
  entry?: string | undefined
  // The security headers every response carries, or `false` for none; a header the app sets itself wins.
  security?: SecurityConfig | boolean | undefined
  // The proxies in front of the server, `true` for one and `{ hops: 2 }` for that many, which the client's address that rate limits count is read through. Left out in production, one proxy is in front for a request from a private address that carries `X-Forwarded-For`; `false` says none is, and the address the server was reached from is the client. Outside production, left out or `false`, the address the server was reached from is the client.
  proxy?: ProxyConfig | boolean | undefined
  // What a route no guard covers comes to. Left out, a site with a guard of its own answers 403 on each page, endpoint and API module no `_guard.ts` covers unless it sets `guards: false`, in its `page` or its `api()` options, and a site with no guard stays open. `default: 'closed'` asks it of every site and of the actions of layouts and `_actions.kay` files too, `default: 'open'` turns it off; `kay check` reports each such route. A library's routes keep the guards it gives them, and a feature that lists or changes private data (`jobs`, `vitals()`, `images.resolve`, `cms()`) is closed with no `guards` whatever the default, opened only by its own `guards: false`.
  guards?: GuardsConfig | undefined
  // Lets other sites' pages call every API module's routes from the browser, as `api({ cors })` does for one, an endpoint file setting its own in `page.cors`: `cors: { origins: ['https://app.example.com'], credentials: true }`. A module setting its own `cors` keeps it, and `api({ cors: false })` keeps a module to its own site.
  cors?: CorsOptions | undefined
  // Serves an OpenAPI 3.1 document of the API modules' routes at `/api/openapi.json`, or at `endpoints.openapi`, read from their schemas, behind the API directory's own `_guard.ts`; `{ reference: true }` adds a page listing them at `/api/reference`, or at `reference: { path }`, `{ dev: true }` keeps both to `kay dev`.
  openapi?: boolean | OpenApiConfig | undefined
  // Serves an MCP endpoint at `/_kay/mcp` over Streamable HTTP, or at `endpoints.mcp`, for an agent to call the app: a tool per API route that sets `tool` in its `detail`, and per action that sets `tool` on its protection. A call runs through the same guards, rate limits and `ctx.locals` as a fetch would.
  mcp?: boolean | McpConfig | undefined
  // Serves a request from another path, query included, such as a host's pages from a section: `url => url.hostname === 'blog.example.com' ? `/blog${url.pathname}` : undefined`. The browser keeps its URL.
  rewrite?: Rewrite | undefined
  // Old paths sent elsewhere with a 308, or the 301, 302 or 307 `status` names, and `{ status: 410 }` for a path that ended, which answers `Gone`: `{ '/blog/:slug': '/posts/:slug', '/docs/*': '/guide/*', '/old': { to: '/new', status: 301 }, '/retired': { status: 410 } }`. `kay check` reports a target no page serves and a 410 that has a `to`.
  redirects?: Redirects | undefined
  // The hosts besides the site's own that a redirect added while the site runs, from a library's screen or `kay not-found --runtime`, may send to: `{ hosts: ['example.org'] }`. None by default, which keeps an editor's redirect on the site.
  runtimeRedirects?: { hosts?: string[] | undefined } | undefined
  // What the live values' connections may cost one client address: how many at once and how many opened a minute.
  live?: LiveConfig | undefined
  // The locales pages are served in, each under its prefix or on its own domain, with messages in `src/messages/<locale>.ts`.
  i18n?: I18nConfig | undefined
  // The IANA time zone dates are written in, `Europe/Paris`: `formatDate` and the dates of kay's own screens, on the server and in the islands alike, unless a call names its own `timeZone`. The server's and the visitor's zone by default, and the one a `schedule` cron is read in unless it names its own `timeZone`.
  timeZone?: string | undefined
  // Where the site is mounted when not at its host's root, `/docs`; `SITE_BASE` when left out, as `site` reads `SITE_URL`, and a `base` written here wins over it. The links, assets, forms and redirects pages render, the sitemap and the feeds carry it, links stay written without it, and a proxy in front of the server takes it off requests.
  base?: string | undefined
  // Whether a page's URL ends with a slash: `never`, the default, redirects `/about/` to `/about`; `always` the other way; `ignore` serves both.
  trailingSlash?: TrailingSlash | undefined
  // The module exporting the project's content collections, `src/content.config.ts` by default; their folders are relative to it.
  contentConfig?: string | undefined
  // How every collection's Markdown compiles; a collection's own option of the same name wins.
  markdown?: MarkdownConfig | undefined
  // Bun plugins the browser build runs, such as Tailwind's.
  plugins?: BunPlugin[] | undefined
  // The app's own module for a kay library's settings, by the library's name: `{ '@kayjs/ui': './src/ui-settings.ts' }`. It replaces the module the library's package.json names as `"kay": { "settings" }`, on the server and in islands alike.
  librarySettings?: Record<string, string> | undefined
  // The level of each lint `kay check`, `kay build`, `kay dev` and the editor report, or of each lint in a group, over its default: `{ 'positional-key': 'deny', 'seo': 'deny', 'unread-name': 'warn' }`. `kay explain` lists them.
  lints?: LintLevels | undefined
  // The app's one secret, at least 32 random characters: it seals `session()`'s cookie, signs form stamps, links to private files and the flash cookie, and gives `preview` its key, each under a key derived for its use. `KAY_SECRET` alone does the same, so this is for a secret kept elsewhere than the environment. A list, or commas in `KAY_SECRET`, rotates it: the first seals and signs, every one opens and verifies: sessions, kayjs-auth's sealed data, stamps, private-file links, the flash cookie and preview links, so a rotation breaks none of them. Development and tests derive one for the checkout; production without any refuses to boot a `session()`, and a production server using none refuses to start, as it would sign with a key of the process, which a restart changes and other replicas do not share; `KAY_EPHEMERAL_SECRET=1` starts it anyway, for a single throwaway server.
  secret?: string | string[] | undefined
  // Lets an editor see drafts on the live site, `false` for none: a visitor in preview mode sees every draft, and pages render for them alone, past prerendered and cached copies.
  preview?: PreviewConfig | boolean | undefined

  // Where the app keeps what outlives one process, for every feature naming no store of its own: `session()`'s data, `cached` values, `live()` values, queued jobs and schedule locks, rate limit counts, the tabs a page's `presence()` lists and the Web Vitals `vitals()` counts and the notifications `notify()` stores, the push subscriptions, the small keyed values libraries keep with an end (`kv`), and the files `files` from `kay/server` keeps in `files`, which only the app writes: `diskFiles('data/files')` by default, `s3Files()` for a bucket, or memory under `bun test`. `sqliteData('data/app.sqlite')` keeps all but the files in one file; `{ sessions, cache, live, jobs, rates, rooms, vitals, notifications, push, kv, files }` takes stores of your own, each optional, Redis say, and each may have `ping` for `health` and `close` for a stop. Without it sessions and jobs stay in `data/app.sqlite`, the one file kay and its libraries share (`session({ store: false })` keeps sessions in their cookie), and the others in memory.
  store?: AppStore | undefined
  // The files `kay env` and `kay check` compare the declared variables with: a compose file or several, and the example env file (`{ compose: 'compose.prod.yaml', example: '.env.example' }`). Each variable production needs must be set by a compose service and listed in the example, and each one the example lists must be declared. `false` turns the comparison off, the default one against the root compose files and `.env.example` included.
  envFiles?: { compose?: string | string[] | undefined, example?: string | undefined } | boolean | undefined
  // The app's own checks, which `kay check` runs with its own: each gets `{ root, routes, report }` and reports problems with `report({ level, message, file, line })`, which join kay's in every format and count toward the exit code. A check that throws, or does not finish within 30 seconds, is reported as an error and the others still run.
  checks?: ProjectCheck[] | undefined
  // What libraries add to the app, each listed once: `extensions: [auth()]`.
  extensions?: KayExtension[] | undefined
}

export interface AssetsConfig {
  images?: ImagesConfig | undefined
  // Self-hosted fonts, declared on every page and preloaded where they ask for it.
  fonts?: (FontConfig | FontsourceConfig)[] | undefined
  // A square image, relative to the root, 512 pixels wide or more for sharp icons, a smaller one enlarged with a warning: kay serves it as `/favicon.ico`, `/apple-touch-icon.png` and the icons of `/manifest.webmanifest`, linked from every page. `{ image, svg }` adds an SVG of it, served as `/favicon.svg` and linked after the ICO; a square SVG alone is both, every icon drawn from it. Defaults to kay's own mark; `false` serves none.
  favicon?: string | FaviconConfig | boolean | undefined
  // The web manifest served with the favicon, named after `seo.name` and described by `seo.description`.
  manifest?: ManifestConfig | undefined
  // How long a browser keeps a file of `public/` without asking again, by the path it is served at, as a glob: `{ '/fonts/**': '365d', '**/*.png': '30d' }`; the first pattern a path matches decides, and a file none names keeps revalidating through its ETag on every visit. Ignored by `kay dev`, so an edit shows at once.
  publicCache?: Record<string, Duration> | undefined
}

export interface OpsConfig {
  // What an app watches the server by: its log, timing, request ids, traces and errors.
  observe?: ObserveConfig | undefined
  // The route a load balancer or a container polls, at `/_kay/health` unless `endpoints.health` names another, or `false` for none.
  health?: HealthConfig | boolean | undefined
  // Serves `/_kay/metrics` in the Prometheus text format for a collector: requests by method, route and status, their durations, scheduled runs, cache reads and live connections. Read only from this machine or a private network by a request no proxy forwarded, or from anywhere with the `Authorization: Bearer` token `KAY_METRICS_TOKEN` holds; `endpoints.metrics` moves it. Off by default, and under `kay dev`.
  metrics?: boolean | MetricsConfig | undefined
  // Serves a page of the app's queues at `/_kay/jobs` in production: each queue's waiting, running and failed jobs with payload and error, and a button to retry or delete one. It mounts only with a `guard`, a kay guard or a list of them such as `ctx => ctx.locals.auth.admin.require()`, which runs on every request, and without one the boot stops. `endpoints.jobs` moves it. Off by default, and under `kay dev`, whose dev tool has a Jobs tab.
  jobs?: JobsConfig | undefined
}

export interface ActionsConfig extends ActionHooks {
  // The checks every action gets, as `protect` of an action's options takes them: an action naming a check replaces the app's, and `protect: false` takes none of them.
  protect?: ActionProtect<string> | undefined
  // The most a post to an action may send, in place of the app's `limits.body` for the actions alone.
  maxSize?: ByteSize | undefined
  // The wording of the refusals, per refusal, replaced by an action's own wording of the same refusal.
  messages?: ProtectionMessages | undefined
}

export interface DirsConfig {
  // Page directory, relative to the root. Defaults to `src/routes`.
  routes?: string | undefined
  // Elysia modules mounted under `/api` by their path, relative to the root: `src/api/chat.ts` serves `/api/chat`. Defaults to `src/api`.
  api?: string | undefined
  // Files served as they are at their path, relative to the root. Defaults to `public`.
  public?: string | undefined
}

export interface LimitsConfig {
  // The most a request with a body to any route may send (`limits.body`), bytes or a size such as `'4mb'`, 1 MB by default; an action or an `api()` module raises or lowers it for itself. A bigger one answers 413 before it is read.
  body?: ByteSize | undefined
  // The most a request to a route of your own (`new Elysia().post()`) may send, by path: the route itself and what is under it, bytes or a size such as '50mb', in place of `limits.body`. The path is the one the server routes, without the `base`.
  byPath?: Record<string, ByteSize> | undefined
}

export interface ServeConfig {
  // Compresses the pages rendered per request, action results, and any Response the app's routes registered after `pages()` return, with brotli or gzip. On by default when NODE_ENV is production; `false` behind a proxy or CDN that compresses already.
  compress?: boolean | undefined
  // A server build with a prerendered page uses its 404 page as a compression dictionary, sending a page to a browser that fetched it as the difference from it; `false` builds none, so no page names it and the build writes no `.dcz` copy.
  compressionDictionary?: boolean | undefined
  // How long a stopping server gives open requests and streams to finish before closing them, a string such as '30s'; 10 seconds by default.
  shutdownTimeout?: Duration | undefined
  // The longest a page, an action, an `api()` route or an endpoint may take to answer, a string such as '15s'; past it the request answers 504 (a page through the nearest `_error.kay`), is logged and handed to `onError`, and `ctx.signal` aborts. None by default. A page sets its own in `export const page = { timeout }`, an `api({ timeout })` module and an action's third argument likewise, `false` for none.
  timeout?: Duration | false | undefined
}

// How kay writes what it logs: the line of each request and kay's own messages.
export interface LogConfig {
  // `'text'`, a line each, or `'json'`, one JSON object each, requests and kay's own messages alike; `'text'` by default.
  format?: 'text' | 'json' | undefined
  // Whether each request gets its line, `true` once the object is given; `false` keeps kay's messages and logs no request.
  requests?: boolean | undefined
  // Receives every entry, request lines and messages, in place of stdout and stderr.
  sink?: ((entry: LogEntry) => void) | undefined
}

export interface ObserveConfig {
  // One line per request on stdout, on by default when NODE_ENV is production, `true` for it outside production too, `false` for none; kay's own messages go out either way. `{ format: 'json', requests, sink }` sets how they are written, as one JSON object each or to a function.
  log?: boolean | LogConfig | undefined
  // A `Server-Timing` header on each action, endpoint and API route, timing its guards and handler, and on each page rendered per request, timing its guards, the import of its modules, its loads and its render for the browser's network panel: on in development, off otherwise unless set.
  serverTiming?: boolean | undefined
  // In development, how long a page's loads may take before kay warns in the console and the dev tool, naming the slowest load: a duration such as `'500ms'`, `'300ms'` by default, `false` for no warning. A page waits for its loads before anything is sent, so one past the budget is a click that waits as long; start what the first paint does not need unawaited and read it in an `await` block.
  loadBudget?: Duration | false | undefined
  // The header a request's id comes in on from a trusted proxy and goes out on, `x-request-id` by default: `'x-correlation-id'`.
  requestIdHeader?: string | undefined
  // An OpenTelemetry tracer, `trace.getTracer('my-site')` from @opentelemetry/api: a span per page request with one per load and the render in it, and one per API request. None by default, which costs nothing.
  tracer?: Tracer | undefined
  // Reads the trace a request arrives in out of its headers, a one-liner with OpenTelemetry: `extract: headers => propagation.extract(ROOT_CONTEXT, Object.fromEntries(headers))`. By default kay reads the W3C `traceparent` header itself, so a tracer's server spans join the caller's trace; `false` ignores incoming traces and starts a new one per request.
  extract?: TraceExtractor | false | undefined
}

export interface ClientConfig {
  // Swaps the next page in place when a link or a form of the site is followed from a page with islands or forms posting to actions, so islands marked `persist` live on; on by default. `false` loads every page as a plain site does.
  navigation?: boolean | undefined
  // Whether a page's stylesheets are written into its head instead of linked, in production: the first paint waits for no stylesheet request, while every page carries them again, since no cache keeps them. Unset, a page inlines them while together they compress under about 14 KB and links them above; `true` and `false` force one way.
  inlineStyles?: boolean | undefined
  // Whether a page that inlines its own rules also links the whole stylesheet, loaded after the first paint: the rules of a class the build cannot read, one an island sets from a value or a server builds from data, then still apply, at the cost of the whole sheet's bytes on every first visit. Off by default, so a page ships only its own rules, and the build warns of a class it cannot read.
  lateStyles?: boolean | undefined
  // Whether a page in French (a `lang` of `fr` or `fr-...`) has the plain space before `: ; ! ?` and inside `« »` in its text, `alt`, `title`, `aria-label` and description made non-breaking, so a mark never wraps alone. On by default, `false` leaves the text as it was typed. Islands write the same spaces in the browser, in an app whose `lang` or `i18n` locales are French.
  typography?: boolean | undefined
  // How far ahead of the viewport islands start to load, as CSS root margins: `visible` for an island marked `hydrate="visible"` (`'200px'` by default), `serverIslands` for a deferred server island (`'100% 0px'`, a screen ahead, by default).
  hydration?: { visible?: string | undefined, serverIslands?: string | undefined } | undefined
  // When the browser fetches a page a link points at before it is followed: `moderate`, the default, on hover, `conservative` on press, `eager` as soon as it can (every link on a page without kay's script, the links scrolled into view, a few at a time, on one shipping it), `false` never. A link with `data-prefetch="false"` never is, and `data-prefetch="eager|moderate|conservative"` on a link or a container sets its own level where kay's script runs.
  prefetch?: Prefetch | undefined
  // Whether a visitor sending `Save-Data: on` gets a lighter site by itself: image variants one width narrower, no font preloads, fonts shown only when cached, no speculation rules; `Save-Data` or `prefers-reduced-data` in the browser also stops the prefetch and has an island with no `hydrate` wait until it scrolls near. On by default, `false` serves everyone alike.
  saveData?: boolean | undefined
  // A service worker keeping the build's files and some pages for a visitor offline, `true` or what it keeps; off by default, as `false` is.
  offline?: OfflineConfig | boolean | undefined
  // `true` has `kay build` index the text of the pages it renders, which `searchSite()` from `kay` searches in the browser; off by default.
  search?: boolean | undefined
  // Where a link leaving the site opens: kay adds `target="_blank" rel="noopener"` to an `a` whose href is another origin, in templates, islands, Markdown and content bodies, unless the element sets its own `target`. `{ outside: 'same-tab' }` writes none.
  // `schemes` lists the URL schemes the app trusts in a bound `href`, `src`, `action`, `formaction`, `xlink:href`, `poster` or `data`, `['webcal', 'geo']`: any other scheme but the web's, mail, phone, sms and blob goes out as `unsafe:`, as `javascript:` would. `javascript`, `vbscript` and `data` are refused. `kay dev` logs each bound URL it rewrote.
  links?: { outside?: 'new-tab' | 'same-tab' | undefined, schemes?: string[] | undefined } | undefined
  // The longest the browser waits for a page it swaps in place, a string such as '10s' (the default): past it the browser loads the page itself, which shows its own progress or error. A page streaming `await` blocks is shown with their pending branches once its first part is in, and this is then the longest the stream may go without a byte before the blocks still pending are left as they are; the server keeps a stream alive every 5 s, so keep it above that.
  pageTimeout?: Duration | undefined
  // How long a link or `navigate()` to another page waits before the page's `_loading.kay` shows in place of the one left, a string such as '200ms' (the default): a page answering sooner never flashes it. Only read on an app with a `_loading.kay`.
  loadingDelay?: Duration | undefined
}

// A problem an app's own check reports; `level` is `'error'` unless it says `'warning'`, `file` is relative to the project and defaults to kay.config.ts, and `line` and `column` default to 1.
export interface ProjectFinding {
  level?: 'error' | 'warning' | undefined
  message: string
  file?: string | undefined
  line?: number | undefined
  column?: number | undefined
  code?: string | undefined
}

export interface ProjectCheckContext {
  // The project's directory.
  root: string
  // The routes the project serves, as `kay routes` lists them: read once, when a check first asks.
  routes: () => Promise<Omit<RouteListing, 'copy'>[]>
  report: (finding: ProjectFinding) => void
}

export type ProjectCheck = (context: ProjectCheckContext) => void | Promise<void>

// What every page's head starts from; a layout or the page setting the same tag wins.
// Each of `name`, `titleTemplate`, `description`, `image`, `imageAlt` and `locale` is a string, or a record of one string per locale for a site with `i18n`: `description: { en: 'The shop', fr: 'La boutique' }`. A locale the record lacks reads the default locale's.
export interface SeoConfig {
  // The site's name: the title of a page that sets none, and `og:site_name`.
  name?: Localized | undefined
  // Wraps the title a layout or the page sets: `%s | Site`; a `title(raw)` stays as it is.
  titleTemplate?: Localized | undefined
  description?: Localized | undefined
  // The social card image, a URL or a path such as an imported asset's.
  image?: Localized | undefined
  // What the card image shows, for `og:image:alt` and `twitter:image:alt`.
  imageAlt?: Localized | undefined
  // Keeps every page out of search engines, `<meta name="robots" content="noindex">`, for a staging site; a page or layout may set its own `robots`.
  noindex?: boolean | undefined
  // The site's Twitter handle, `@site`.
  twitter?: string | undefined
  // `og:locale`, such as `fr_FR`.
  locale?: Localized | undefined
  // The colour browsers paint around the page, `#1e1e2e`, or a `{ light, dark }` pair for each colour scheme of the visitor; defaults to `manifest.themeColor`, which keeps its own value for the installed app.
  themeColor?: string | { light: string, dark: string } | undefined
  // Structured data every page carries, such as the site's `WebSite` or `Organization`.
  jsonLd?: JsonLd[] | undefined
}

// Paths of the site, written without the mount point and the locale: each is listed for every locale the host serves. One may end in `*` or `$` as robots.txt allows.
export interface RobotsConfig {
  // Paths crawlers are asked to leave alone.
  disallow?: string[] | undefined
  // Paths allowed inside a disallowed one.
  allow?: string[] | undefined
}

export interface PreviewConfig {
  // Signs preview links and the preview cookie, never carried in a URL: at least 32 random characters, read from the environment. A key derived from the app's secret (`KAY_SECRET`) when left out.
  secret?: string | undefined
  // How long a visitor stays in preview mode once in, a string such as '2h'; an hour by default.
  maxAge?: Duration | undefined
  // Revokes the share links `previewUrl(path, { entry })` made for an entry: given the entry, it answers the time (a `Date` or milliseconds) before which no link of it is accepted, or nothing when none is revoked. A link made earlier is refused as an expired one, so no list of links is kept; kayjs-cms supplies this itself.
  sharedNotBefore?: ((entry: PreviewScope) => Date | number | undefined | Promise<Date | number | undefined>) | undefined
}

export interface GuardsConfig {
  default?: 'open' | 'closed' | undefined
}

export interface LiveConfig {
  // How many live connections one client address holds at once, 20 by default: a few tabs, not a flood. One more answers 429.
  connections?: number | undefined
  // How many openings a client address may make in a window, `{ max: 120, window: '1m' }` by default, the shape of every rate limit in kay, or `false` for no limit.
  rateLimit?: Omit<RateLimit, 'key'> | boolean | undefined
}

// Where the app's API and kay's own features are served, each an absolute path of plain segments without a trailing slash, none under `/_kay`.
export interface EndpointsConfig {
  // The prefix the API modules are served under, `/api` by default: `endpoints: { api: '/v1' }` serves `src/api/chat.ts` at `/v1/chat`. Libraries read it through `apiUrl()`.
  api?: string | undefined
  // Where the OpenAPI document is served, `/api/openapi.json` under the API prefix by default; its reference page is set in `openapi.reference`.
  openapi?: string | undefined
  // Where the MCP endpoint is served, `/_kay/mcp` by default.
  mcp?: string | undefined
  // Where the health check is served, `/_kay/health` by default.
  health?: string | undefined
  // Where the metrics are served, `/_kay/metrics` by default.
  metrics?: string | undefined
  // Where the page of the queues is served, `/_kay/jobs` by default.
  jobs?: string | undefined
}

export interface JobsConfig {
  // Who may open the page: a guard, a list of them run in order, or `{ load }` returning one. Left out the page answers 403, as every feature that lists or changes private data does; `false` opens it to everyone.
  guards?: GuardOption | false | undefined
}

export interface MetricsConfig {
  // The bearer token a scrape must send, from anywhere: `true` reads `KAY_METRICS_TOKEN`, a string is the token, `{ env }` names the variable and `{ file }` the file that holds it. Left out it is `KAY_METRICS_TOKEN` when that is set; with no token only a request from this machine or a private network that no proxy forwarded is answered.
  token?: true | Secret | undefined
}

export interface HealthConfig {
  // How long `check` may take before the route fails with 503, and how long `--health` waits for the route: a string such as `'250ms'` or `'10s'`; 5 seconds by default.
  timeout?: Duration | undefined
  // Fails the route with 503 when it returns false or throws, such as a database that does not answer.
  check?: (() => unknown) | undefined
}

export interface SecurityConfig {
  // Directives merged over kay's Content-Security-Policy, `{ 'img-src': ["'self'"] }`, one given `false` left out, or `false` for no policy; `script-src` keeps the hashes of kay's inline scripts.
  csp?: Record<string, string[] | false> | boolean | undefined
  // Directives merged over the enforced policy and sent as `Content-Security-Policy-Report-Only`, to see what a stricter policy would block before enforcing it.
  reportOnly?: Record<string, string[] | false> | undefined
  // Where browsers report what either policy blocks: `true` for kay's own route, which logs each violation and hands it to `onError` as a `CspViolationError`, or a collector's URL.
  reports?: true | string | undefined
  // Features merged over kay's Permissions-Policy, which refuses camera, microphone, geolocation, payment, usb and browsing-topics: `{ microphone: 'self' }`, `{ geolocation: ['self', 'https://maps.example.com'] }` or `{ camera: '*' }`, one given `false` left out of the policy. A `permissions-policy` in `headers` still replaces the whole header.
  permissions?: Record<string, string | string[] | false> | undefined
  // Headers merged over kay's, one given `false` not sent: `{ 'strict-transport-security': 'max-age=63072000; includeSubDomains' }`.
  headers?: Record<string, string | false> | undefined
  // Production answers 421 to a request whose `Host` is not the site's, one of the `i18n` locale hosts or listed here, against DNS rebinding and a link built from `ctx.url.origin` poisoned by the header: `true` allows those alone, which is the default once `site` is set, and `false` trusts every `Host`. Localhost and IP addresses always pass, as a health check reaches the server by them. Under `kay dev` it is `KAY_DEV_HOSTS` instead.
  hosts?: string[] | boolean | undefined
  // What a cookie set with `ctx.cookies.set` gets for an option it does not give, so an app's cookies are as hardened as kay's own, on by default: `HttpOnly`, `SameSite=Lax`, `Secure` over https and `Path` the `base`, and a call's own option wins. `false` (or `security: false`) leaves Bun's plain defaults (`SameSite=Lax`, `Path=/`, neither `HttpOnly` nor `Secure`).
  cookies?: CookieDefaults | boolean | undefined
}

export interface CookieDefaults {
  // Defaults to `true`.
  httpOnly?: boolean | undefined
  // Defaults to `'lax'`; `'none'` is always `Secure`.
  sameSite?: 'lax' | 'strict' | 'none' | undefined
  // `'auto'`, the default, follows the scheme the request came over (its URL, or `X-Forwarded-Proto` behind a proxy), so a plain-http localhost keeps working.
  secure?: boolean | 'auto' | undefined
  // Defaults to the `base`, else `/`. A cookie deleted without a path takes it too.
  path?: string | undefined
}

// `hops` or `header`, not both, and with `key` alone one proxy is in front: read only from a request coming from this machine or a private network, so a client reaching the server directly cannot forge it.
export interface ProxyKey {
  header: string
  secret?: Secret | undefined
}

export interface ProxyConfig {
  // The proxies that each append to `X-Forwarded-For`: 1 for nginx or Caddy alone, 2 for Cloudflare then nginx.
  hops?: number | undefined
  // The header a proxy sets to the client's address, such as `cf-connecting-ip` or `x-real-ip`, read instead of `X-Forwarded-For`.
  header?: string | undefined
  // The public address ranges the proxy reaches the server from, such as a CDN's published ones, `173.245.48.0/20`: trusted besides this machine and private networks.
  trusted?: string[] | undefined
  // `false` trusts the `trusted` ranges alone, instead of this machine and private networks too: for a server whose private neighbours are not all its proxies. Goes with `trusted`.
  trustPrivate?: false | undefined
  // The key the proxy shares with the server, sent in the header `header` names, such as `{ header: 'x-upstream-key' }`: a request without it, or with another value, is refused with 403, so a process or a container reaching the port directly skips nothing the proxy does. `secret` is the key, `{ env }` or `{ file }`; left out it is read from `KAY_PROXY_KEY`, else from the file `KAY_PROXY_KEY_FILE` names. Compared in constant time. Off under `kay dev` and outside production without a key; a production server with none does not boot.
  key?: ProxyKey | undefined
  // Paths, and what is under them, that need no key besides the health route: `['/api/push']`, read after the base is taken off.
  open?: string[] | undefined
}

export interface FontConfig {
  family: string
  // A font file relative to the root, or a file of an installed package: `@fontsource-variable/inter/files/inter-latin-wght-normal.woff2`.
  src: string
  // A weight, or a range for a variable font: `100 900`. Defaults to 400.
  weight?: number | string | undefined
  style?: 'normal' | 'italic' | undefined
  // Defaults to `swap`.
  display?: 'auto' | 'block' | 'swap' | 'fallback' | 'optional' | undefined
  unicodeRange?: string | undefined
  // Fetched with the page rather than once the stylesheet asks for it; off by default, since a preload shares a slow link with the stylesheet and holds back the first paint.
  preload?: boolean | undefined
}

// Every face of a Fontsource family the site uses, its name and files read from the package.
export interface FontsourceConfig {
  // An installed package: `@fontsource/inter`, or `@fontsource-variable/inter`, whose one face per style spans every weight.
  fontsource: string
  // The weights a package of static faces declares, `[400, 600, 700]`; a variable one takes none.
  weights?: number[] | undefined
  // Defaults to `['normal']`.
  styles?: ('normal' | 'italic')[] | undefined
  // Defaults to the package's own, `latin` for most; several, `['latin', 'latin-ext']`, give each face its subset's `unicode-range`, so a page loads only the files its text needs.
  subsets?: string[] | undefined
  display?: FontConfig['display'] | undefined
  // Preloads every face the entry declares, as `preload` does a font's: give it to an entry of one subset and the faces the first paint shows.
  preload?: boolean | undefined
}

// A favicon with an SVG of it: kay makes the ICO and the PNG icons from `image`, and serves `svg` as it is.
export interface FaviconConfig {
  image: string
  svg: string
}

export interface ManifestConfig {
  // The name under the icon on a home screen; defaults to `seo.name`.
  shortName?: string | undefined
  // Also every page's `theme-color`, unless `seo.themeColor` sets one: a colour, or a `{ light, dark }` pair for each colour scheme of the visitor, as `seo.themeColor` takes. A manifest holds one `theme_color`, so the installed app gets the `light` one.
  themeColor?: string | { light: string, dark: string } | undefined
  backgroundColor?: string | undefined
  display?: 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser' | undefined
  orientation?: 'any' | 'natural' | 'landscape' | 'landscape-primary' | 'landscape-secondary' | 'portrait' | 'portrait-primary' | 'portrait-secondary' | undefined
  // The page the installed app opens, a path of the site; defaults to `scope`, else `/`.
  startUrl?: string | undefined
  // The paths the installed app keeps in its window, a path of the site; browsers default to the start page's directory.
  scope?: string | undefined
  // A square image relative to the root, its subject inside the middle 80% a launcher may crop to a circle: kay serves it as the manifest's maskable icons.
  maskable?: string | undefined
  // The pages a launcher offers from the app's icon.
  shortcuts?: ManifestShortcut[] | undefined
  // Lists the installed app among the apps a device's share sheet offers, the shared title, text, link and files posted to an action.
  shareTarget?: ManifestShareTarget | undefined
}

export interface ManifestShareTarget {
  // Where a share is posted: an action as `'src/routes/share.kay#receive'`, the page file relative to the root and the exported action's name, or a path of the site (`'/share'`) for a route of your own taking a POST. The action reads `title`, `text`, `url` and `files`, whichever the sharing app sent, all optional.
  action: string
  // The kinds of file the app takes, as MIME types or extensions (`['image/*', '.pdf']`); with some the share is posted as `multipart/form-data` and the action reads them as `files`, without any only text and a link are shared.
  files?: string[] | undefined
  // The field each part of a share is posted as, `title`, `text`, `url` and `files` by default.
  params?: { title?: string | undefined, text?: string | undefined, url?: string | undefined, files?: string | undefined } | undefined
}

export interface ManifestShortcut {
  name: string
  // A path of the site.
  url: string
  shortName?: string | undefined
  description?: string | undefined
}

export interface OfflineConfig {
  // The pages read offline once the worker installed, as paths of the site: every prerendered page no guard covers by default.
  pages?: string[] | undefined
  // The page shown offline for any other, such as `/offline`, a page of the site; a plain one kay writes by default.
  fallback?: string | undefined
}

export interface MarkdownConfig {
  // Highlights code blocks when the entries compile, at build time, such as with Shiki: `(code, language) => html`, the whole `<pre>`.
  highlight?: Highlighter | undefined
  // Rewrites the HTML Markdown renders for each entry, `(html, entry) => html` with `entry` the `{ file, slug, locale }`, once as the entries compile: add `rel` to links, shift headings, turn `:::note` into an admonition. It runs before headings are read and code is highlighted, and a loader's untrusted body is sanitized after it. Leave `<kay-component>` elements as they are.
  transform?: MarkdownTransform | undefined
  // Rewrites each entry's Markdown before it is read, `(markdown, entry) => markdown`, for syntax of your own; components, headings and the rest keep working on what it gives back.
  preprocess?: MarkdownPreprocess | undefined
  // `:::note Title` … `:::` as an `<aside class="admonition note">` whose inside is Markdown; off unless set.
  containers?: boolean | undefined
  // `[^id]` references and `[^id]: text` definitions as numbered marks and a closing list with links back; off unless set.
  footnotes?: boolean | undefined
  // Whether a heading links to its own anchor, on by default; `false` leaves the heading's text plain, with its id.
  headingLinks?: boolean | undefined
  // Words a minute an entry's `readingTime` counts at, 230 by default.
  readingSpeed?: number | undefined
  // The `sizes` of the relative images in Markdown bodies, `100vw` unless set: how wide they show, such as `(min-width: 60rem) 40rem, 100vw`. An image's own `sizes` attribute wins.
  imageSizes?: string | undefined
}

export interface SitemapConfig {
  // How long the sitemap is served before the next request builds it again, a string such as `'15m'`; an hour by default, a minute when a `lastmod` was left out. An `invalidate` of a key or collection it read, or a `publishAt` date passing, drops it sooner.
  ttl?: Duration | undefined
}

export interface ImagesConfig {
  // How long a variant the image route made on request is kept once nothing wrote it, a string such as `'7d'`; 30 days by default. Past it the server removes the file as it starts and once a day, and the next request draws it again.
  ttl?: Duration | undefined
  // Directories of images added at runtime, such as uploads, by the URL path the app serves them at: `{ '/uploads/': 'data/uploads' }`. The image route resizes those as well as imported images, reading them on each request; a directory is relative to the root, or where an executable runs.
  dirs?: Record<string, string> | undefined
  // Images on other hosts, resized too: `{ hosts: ['https://cms.example.com/uploads/'] }`. The image route downloads them, keeping a copy it revalidates; a host not listed is refused, so the route is no open proxy.
  remote?: RemoteImages | undefined
  // How the variants are encoded.
  formats?: ImageFormats | undefined
  // The most variants one client may have the image route encode in a window, counted by its address (the forwarded one behind a trusted `proxy`); a variant already made is never counted. Past it the route answers 429 with `Retry-After`. `{ max: 120, window: '1m' }` by default, `false` for no limit.
  rateLimit?: Omit<RateLimit, 'key'> | boolean | undefined
  // What the route spends on variants nobody has made yet.
  limits?: ImageLimits | undefined
  // The widths in pixels `image()` resizes to and the route makes, whole numbers from 1 to 16384, at most 16, in any order: `[480, 960, 1440, 1920]`. Defaults to `[320, 640, 960, 1280, 1920, 2560]`, and no variant is wider than the last width, which a list of your own does not do: it also gets each image's own size. Each width is a file per image, so a short ladder builds fewer.
  widths?: number[] | undefined
  // The most pixels per CSS pixel an image loads at on a denser screen, at least 1. Defaults to 2: a 3x phone loads what a 2x one does, which looks the same; `Infinity` leaves the browser's choice.
  maxDensity?: number | undefined
  // `false` leaves out the color an image's box shows until it loads, which kay reads off each imported, Markdown, `dirs` and `remote` image without transparency; `image(src, { placeholder: false })` and `no-placeholder` on an `img` leave out one image's. Shown as a `style` attribute, so a CSP without `'unsafe-inline'` for styles drops it.
  placeholder?: boolean | undefined
  // The aspect ratios `image(src, { aspect })` may cut to, each one adding a variant per width the route makes on request: `['1/1', '3/2', '2/3', '4/3', '3/4', '16/9', '9/16']` by default.
  aspects?: string[] | undefined
  // How `shareCard()` draws a page's card.
  card?: CardConfig | undefined
  // The file of an image `src` no import, stored file, `dirs` entry or remote host names, looked up the app's own way: `(src, ctx) => mediaPath(src.slice('/media/'.length))`. A path relative to the root, or undefined for a 404; `ctx` is a guard's, its `deny()` and `redirect()` included. `image(src, { width, height })` then resizes any `src` starting with `/`, and these answers are private to the browser.
  resolve?: ((src: string, ctx: GuardContext) => string | undefined | Promise<string | undefined>) | undefined
  // Run before `resolve`, as a page guard: `guards: ctx => { if (!ctx.locals.session.get('user')) ctx.deny(401) }` resizes those images for signed-in users alone. A list or `{ load }` is taken too. Left out, a `resolve` answers 403 for every image, since it reads files the app chooses; `false` opens them to everyone.
  guards?: GuardOption | false | undefined
}

export interface RemoteImages {
  // Each an origin and maybe a path, its host maybe starting with `*.` for any subdomain: `['https://cms.example.com/uploads/', 'https://*.cdn.example.com']`.
  hosts?: string[] | undefined
  // The most a remote original may weigh, bytes or a size such as `'10mb'`: a bigger one answers 413 and is not kept. 25 MB by default.
  maxSize?: ByteSize | undefined
  // How long the image route waits for a remote host, redirects included, a string such as `'30s'`; 10 seconds by default. A slower host answers 502.
  timeout?: Duration | undefined
}

export interface ImageFormats {
  // WebP quality, 1 to 100. Defaults to 80. It also sets the quality of the share cards' JPEG, which `webp.quality` leaves alone; `image(src, { quality })` sets one image's variants.
  quality?: number | undefined
  // WebP variants beside the AVIF ones: `{ quality: 75 }` over `quality`, for the variants alone.
  webp?: { quality?: number | undefined } | undefined
  // AVIF variants beside the WebP ones, a third to a half smaller, sent to a browser whose `Accept` names `image/avif`: on at quality 50 by default, `false` serves WebP alone. Development and a static export serve WebP.
  avif?: boolean | { quality?: number } | undefined
}

export interface ImageLimits {
  // The most variants the route keeps cached of one source image, so a client varying width, quality, crop and format cannot fill the cache without bound. Past it the oldest cached variant of that image is removed to make room, and one asked for again is encoded again, within `rateLimit`. Counted from the files on disk. 256 by default, `false` for no limit.
  variants?: number | false | undefined
  // The most encodes waiting for one of the four being drawn; past it the route answers 503 with `Retry-After` rather than queue more. 128 by default, `false` for no limit.
  queue?: number | false | undefined
}

export interface CardConfig {
  // The face the title is drawn in, among `fonts`: the first family listed, at the weight nearest 700 it has, by default. A variable face draws at its default weight.
  font?: { family: string, weight?: number } | undefined
  // `#rrggbb` behind a card with no image, and what an image fades into below the title: `#111111` by default.
  background?: string | undefined
  // The text's `#rrggbb`, `#ffffff` by default.
  color?: string | undefined
  // A square image relative to the root, an SVG or a PNG, JPEG or WebP, drawn at the top left of every card: `'src/logo.svg'`.
  logo?: string | undefined
}

export type TrailingSlash = 'never' | 'always' | 'ignore'

// How the locales show in a URL: `'prefix'`, the default, serves the default locale's pages unprefixed and the others under `/en`; `'always'` puts the default locale under its prefix too, `/fr/about`, and an unprefixed path then redirects to the visitor's locale, from their cookie or their browser's languages; `{ domains: { fr: 'example.fr', en: 'example.com' } }` serves each locale on its own host in place of prefixes, a host not listed serving the default locale.
export type I18nMode = 'prefix' | 'always' | { domains: Record<string, string> }

export interface I18nConfig {
  // BCP 47 tags, `['fr', 'en']`.
  locales: string[]
  // The locale a path naming none is served in, one of `locales`.
  default: string
  mode?: I18nMode | undefined
  // A page's path in the locales naming it their own way, by the pattern the page is served under: `{ '/about': { fr: '/a-propos' }, '/blog/:slug': { fr: '/articles/:slug' } }`; its untranslated path in that locale redirects there.
  paths?: Record<string, Record<string, string>> | undefined
  // The directory of the `<locale>.ts` message files, relative to the root: `src/messages` by default.
  messages?: string | undefined
}

// A problem an extension finds in how the app configured it, shown by `kay check` and the editor beside kay's own.
export interface ExtensionProblem {
  message: string
  // The file it is found in, absolute or relative to the project root; `kay.config.ts` by default.
  file?: string | undefined
  // `'warning'` by default.
  severity?: 'warning' | 'error' | undefined
  help?: string | undefined
}

// What kay hands an extension's `server` function, and an API module of its `api` exporting a function: the root its own files (a database file, a cache) live under, the modules of the files it named in `appFiles`, and the names of the extensions the config lists.
export interface ExtensionApp {
  // The project root, or the folder an executable runs in.
  root: string
  // The `name` of every extension the config lists, the app's `src/plugins` files included, for an extension to tell which libraries the app registered, in an executable too.
  extensions: string[]
  // The cookies of the test site this app is built for, set by `testSite()` only: what a library tells that site by.
  testCookies?: Bun.CookieMap | undefined
  // The database the app's `store` keeps its data in (`AppStore.database`), for an extension keeping tables of its own there.
  database?: string | undefined
  // Set while a static export starts the server to render the pages: an extension keeps its data in memory then, and creates or migrates nothing in a database.
  exporting?: boolean | undefined
  modules: Record<string, Record<string, unknown> | undefined>
}

// What a library hands the app to list in `extensions`: pages it serves, the texts they show, the config it needs and the server plugin they run on, as if they were the app's own.
export interface KayExtension<Server extends PluginInput = AnyElysia> {
  name: string
  // Set when the extension does nothing without a running server, as a tracker posting to a route of its own: `kay build --static` warns of it, as that export runs no extension's server.
  needsServer?: boolean | undefined
  // Set when the extension counts visitors only after their yes on the `kay_analytics` cookie, so another extension measuring visitors, such as `vitals()`, waits for the same yes.
  asksConsent?: boolean | undefined
  // The most a request to the extension's routes may send, by path: the route itself and what is under it, bytes or a size such as '8mb', in place of the app's `limits.body` that every other route with a body has.
  maxSizeByPath?: Record<string, ByteSize> | undefined

  // Files a static export writes into the site, by their path, for what the extension's server would otherwise serve as a constant, such as a script every page loads: `kay build --static` runs no server plugin.
  staticFiles?: Record<string, string> | undefined
  // An Elysia plugin `pages()` uses before the pages, actions and API modules, so its derives reach their `ctx.locals` and `kay check` types them; scoped or global hooks reach them, local ones only the plugin's own routes.
  // Given as a function, it is called only when `pages()` builds the app, never when `kay check`, the editor or `kay build` read the config: the way to hand a plugin built on a database or the server's environment.
  server?: Server | ((app: ExtensionApp) => Server | Promise<Server>) | undefined
  // Optional files of the app the extension reads, by the name it reads them by and their path under the project root: `{ hooks: 'src/auth.ts' }`. kay imports each one that exists as the server starts and hands the modules to a `server` function as `app.modules` (undefined for a file the app has not written), bakes them into an executable `kay build --compile` makes, and reloads them under `kay dev` when one is edited, added or removed. Only a `server` function and the API modules of `api` exporting a function receive the modules, though every file is baked and reloaded. A path outside the project root stops the server.
  appFiles?: Record<string, string> | undefined
  // The server plugin named by the module that exports it, `{ path: './src/auth', export: 'auth' }` for `export const auth` (`default` by default): imported only as `pages()` builds the app, and baked into an executable `kay build --compile` makes, which a path built at run time inside a library could not be. The export is the plugin, a function building it, or an object carrying it as `plugin`, as a library's `authCore` result does. `kay check` types the locals off the module itself, and off the extension's `Server` argument when it has one; used beside `server`, the module wins. A path is relative to the project root. `prepare` runs with the export before the plugin is taken from it, for a library to hand the app's module what the extension was given; a throw stops the server.
  serverModule?: { path: string, export?: string | undefined, prepare?: ((exported: unknown) => void | Promise<void>) | undefined } | undefined
  // Config laid under the app's `kay.config.ts`: objects merged key by key, arrays joined with the extension's items first, any other value the app sets winning. Bun plugins the library's files need go in its `plugins`. It takes what `kay.config.ts` does.
  config?: Omit<ConfigInput, 'extensions'> | undefined
  // A module whose default export is `defineUi({ ... })`, written as `src/ui.ts` is (string and object literals only), absolute or relative to the project root: the parts and variants it sets for components, the app's own or a library's, reach every app listing the extension, under the app's own `src/ui.ts`. A part or a variant value the app sets replaces the extension's, and a later extension's replaces an earlier one's. Names and relative specifiers resolve from the app's `src/`.
  ui?: string | undefined
  // A directory of `.kay` pages, layouts and guards laid over the app's routes under `prefix`, the root by default: a file of the app at the same path replaces the library's.
  // Its directories are absolute, as a library gives them from `import.meta.dir`, or relative to the project root.
  routes?: { dir: string, prefix?: string | undefined } | undefined
  // A `.kay` layout wrapping every page outside the app's own layouts, rendering its `slot` and then what the library mounts on every page, as a toaster: absolute or relative to the project root, and alone in its directory. A page or layout setting `layouts: false` starts afresh without it. `{ file, reaching }` wraps only the pages whose import graph (the page, its layouts and every `.kay` file and app script they import, however deep) reaches one of the `reaching` files, so a library needing per-request data on the first bytes pays for it only where its components are used.
  layout?: string | { file: string, reaching: string[] } | undefined
  // Stylesheets the app's own stylesheets may `@apply` utilities from and read `theme()` tokens of with no `@reference` line, as if each began with one: absolute paths, or specifiers Tailwind resolves from the stylesheet. kay adds an `@reference` after the Tailwind import of each stylesheet of the app, which writes no rule, so a stylesheet that already imports or references the file is not loaded twice.
  references?: string[] | undefined
  // A module whose default export is `defineContext(load)` from `kay/server`, absolute or relative to the project root: `load(request)` returns the request values the extension gives every template as `ctx`, `ctx.user` or `ctx.can('admin')`, with no `--- server` fence. It runs at most once per request, ahead of the render of each page whose imports reach a template that reads `ctx`, and of no other, which is then the visitor's own as a page reading `ctx.locals` is. `defineContext({ key: load })` gives one loader per key instead, each run only for a page whose templates read that key. `kay check` and the editor type `ctx` off the module itself; two extensions giving one key stop the page.
  context?: string | undefined
  // A directory of API modules laid over the app's under `prefix`, the root by default, as `routes` is over its pages: `{ dir: 'api', prefix: 'auth' }` serves `api/session.ts` at `/api/auth/session`, unless the app has `src/api/auth/session.ts`.
  // A prefix starting with `/_kay/` is absolute, served there whatever `endpoints.api` is. `former` is the prefix it had under `endpoints.api` before it moved: that path still answers, as the new one, for the releases the library says.
  // A module may default-export a function of the `ExtensionApp` building its instance, `({ modules }) => api({ cors }).get('/', () => modules.features)`, called as the app is built, so it serves the app's `appFiles`.
  api?: { dir: string, prefix?: string | undefined, former?: string | undefined } | undefined
  // A directory of message catalogs, `<locale>.ts` each, under the app's own: a key the app translates is the app's.
  messages?: string | undefined
  // The environment variables the library reads, as a `defineEnv` schema: `kay env` lists them with the app's own, so a deploy script knows what to set without wiring the library. A field with `requiredInProduction: true` is one production needs.
  env?: EnvSchema | undefined
  // A `.kay` island every page renders at the end of its body in edit mode alone, kept alive across navigations, given `{ entries, unclickable }`: each entry the page read and the fields a click cannot reach, as `kay/edit`'s `EditorProps` types them. Absolute, or relative to the project root; one extension at most gives one.
  editor?: string | undefined
  // A browser module that adds to the dev tool every dev page carries, named by an absolute path (from `import.meta.dir`) or relative to the project root: kay serves it in development alone, loads it after the tool, and calls its default export with the `DevTool` (`import type { DevTool } from 'kay/dev-tool'`). It is a single file, as nothing bundles its imports, and gets its data from a dev-only route of the library's own. One that fails is logged as a problem and the others still load.
  devTool?: { module: string } | undefined
  // Commands it adds to `kay`, by a name of one word or more, `{ 'i18n translate': `${import.meta.dir}/translate.ts` }`: each a module, absolute or relative to the project root, whose default export is a `KayCommand` from `kay/library`, loaded only when it runs or `kay --help` lists it. A name kay has, or one another extension gives, stops the command.
  commands?: Record<string, string> | undefined
  // Called by `kay check` and the editor, with the content config read and its collections registered, in place of running `server`: returns the problems with how the app configured the extension that the server would otherwise only log or refuse once it listens. Name the collection and the field path in each message.
  check?: (() => ExtensionProblem[] | Promise<ExtensionProblem[]>) | undefined
  // Lints the extension answers for the places it fills in by itself, so `kay check` drops them there: `['missing-alt']` for an extension writing the `alt` of every `img` of a server-rendered page whose `src` is an imported image. Only `missing-alt` is relaxed so far, and only for such an `img`; one rendered inside an island is still reported.
  satisfies?: 'missing-alt'[] | undefined
  // Called with each page `kay build` prerenders, once the files it links are written and before it is compressed, and again when the server renders it afresh: returns the HTML to write.
  transformPage?: PageHook | undefined
  // Called with each page the server renders for a request and no prerendered copy answers, in `kay dev` too: a page of `prerender: false`, a guarded page, a params page `kay build` did not render. It returns the HTML to send, and a page whose HTML is not served as `text/html` is left alone. A site whose extensions carry none pays nothing; one that does buffers each such page, so a hook must be quick and never wait on slow work, such as a model's reply.
  transformServedPage?: PageHook | undefined
}

// What kay sets on the config it loads, never the app: `publicEnv` is set when `src` holds an `s.Public` field, which sends the browser its environment.
export interface InternalConfig {
  publicEnv?: boolean | undefined

}

// The config as kay reads it once loaded: what `kay.config.ts` wrote and what kay added.
export type LoadedConfig = KayConfig & InternalConfig

// A list a CMS or a database may hold: the value, or a function returning it (or a promise of it), which kay calls once as the config loads.
export type Loadable<Value> = Value | (() => Value | Promise<Value>)

// `cors` of the config: `origins` may be loaded.
export type ConfigCors = Omit<CorsOptions, 'origins' | 'credentials'> & ({ origins: '*', credentials?: false | undefined } | { origins: Loadable<readonly string[]>, credentials?: boolean | undefined })

type Over<Bag, Given> = Omit<Bag, keyof Given> & Given

// What `kay.config.ts` may write: `KayConfig` with each list that may come from a CMS or a database loadable. Kay turns it into a `KayConfig` as it loads.
export interface ConfigInput extends Omit<KayConfig, 'cors' | 'security' | 'proxy' | 'robots' | 'redirects' | 'i18n' | 'assets'> {
  assets?: Over<AssetsConfig, { images?: ImagesInput | undefined }> | undefined
  cors?: ConfigCors | undefined
  security?: boolean | Over<SecurityConfig, { hosts?: Loadable<string[]> | boolean | undefined }> | undefined
  proxy?: boolean | Over<ProxyConfig, { trusted?: Loadable<string[]> | undefined }> | undefined
  robots?: boolean | Over<RobotsConfig, { disallow?: Loadable<string[]> | undefined, allow?: Loadable<string[]> | undefined }> | undefined
  redirects?: Loadable<Redirects> | undefined
  i18n?: I18nInput | undefined
}

export type I18nInput = Over<I18nConfig, { default?: string | undefined, paths?: Loadable<Record<string, Record<string, string>>> | undefined }>

export type ImagesInput = Over<ImagesConfig, { remote?: Loadable<string[]> | Over<RemoteImages, { hosts?: Loadable<string[]> | undefined }> | undefined }>

export const CONFIG_FILE = 'kay.config.ts'
// The app's own request values for templates, listed as an extension's `context` while the file exists.
export const APP_CONTEXT = 'src/context.ts'

// The known key a mistyped one differs from by its case alone, which a type can tell; `kay check` names the nearest by distance.
type CaseVariant<Key, Known> = { [Name in keyof Known & string]: Lowercase<Name> extends Lowercase<Key & string> ? Name : never }[keyof Known & string]

// What an unknown key's value must be: a string naming the problem, which nothing a config gives matches, so the error lands on the key.
type Misspelled<Key, Known> = [CaseVariant<Key, Known>] extends [never] ? 'unknown option' : `unknown option, did you mean \`${CaseVariant<Key, Known> & string}\`?`

// A symbol key is no option a config names, and an object a library returns may carry one, as `pgData()`'s `Symbol.asyncDispose` does.
type UnknownKeys<Given, Known> = Given extends object ? { [Key in Exclude<keyof Given, AllKeys<Known> | symbol>]: Misspelled<Key, Known> } : unknown

// The keys of every member of a union of object shapes (`{ env } | { file }`), where `keyof` keeps only the keys they share, none for that one.
type AllKeys<Known> = Known extends unknown ? keyof Known : never

type Method = (...args: never[]) => unknown

// The keys of a type that are required methods, which an object an app hands over (a `Tracer`) has and an option bag has not.
type RequiredMethods<Value> = keyof { [Key in keyof Value as Record<never, never> extends Pick<Value, Key> ? never : Value[Key] extends Method ? Key : never]: unknown }

// The types that take any name for a key, which no typo can be told from: the level of each lint.
type FreeKeys = LintLevels

// The option bag a key's type holds, if any: an object type that is no list, no function, no record of free keys and has no required method, so a `Tracer`, a list of entries or a function is never checked as one.
type BagOf<Value> = Value extends readonly unknown[] | Method | FreeKeys ? never : Value extends object ? (string extends keyof Value ? never : [RequiredMethods<Value>] extends [never] ? Value : never) : never

// How deep the option bags nest at most, which no config comes near.
type Deepest = [unknown, unknown, unknown, unknown]

// The config with every key `KayConfig` and the option bags it holds, however deep, lack typed so that setting it is an error: an inferred type parameter gets no excess property check of its own. A bag added to `KayConfig` is covered with nothing to list. The bags are walked by the known type rather than by the given config's keys, as a mapped type over those loses the contextual type of a callback elsewhere in the config.
type Checked<Given, Known, Depth extends unknown[] = []> = UnknownKeys<Given, Known> & (Depth['length'] extends Deepest['length'] ? unknown : { [Key in keyof Known]?: [BagOf<NonNullable<Known[Key]>>] extends [never] ? unknown : Checked<Key extends keyof Given ? Given[Key] : unknown, BagOf<NonNullable<Known[Key]>>, [...Depth, unknown]> })

// Gives the config back as written, so `kay check` reads the types of what it declares off it.
export function defineConfig<Config extends ConfigInput>(config: Config & Checked<Config, ConfigInput>): Config {
  return config
}

// The listed keys of the config, each one present and undefined when the config leaves it out.
export function pickConfig<Key extends keyof KayConfig>(config: KayConfig, keys: readonly Key[]): Pick<KayConfig, Key> {
  return Object.fromEntries(keys.map(key => [key, config[key]])) as Pick<KayConfig, Key>
}
