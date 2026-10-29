import type { BunPlugin } from 'bun'
import type { AnyElysia } from 'elysia'
import type { BudgetConfig } from './build/budget'
import type { Listed as RouteListing } from './commands/routes'
import type { LintLevels } from './compiler/lints'
import type { Highlighter } from './content/markdown'
import type { ByteSize } from './runtime/byte-size'
import type { Duration } from './runtime/duration'
import type { HeadTag } from './runtime/head'
import type { Guard, GuardContext } from './runtime/index'
import type { Localized } from './runtime/localized'
import type { JsonLd } from './runtime/seo'
import type { McpConfig } from './server/api-modules'
import type { AppStore } from './server/app-store'
import type { CorsOptions } from './server/cors'
import type { EnvSchema } from './server/env'
import type { Logger } from './server/log'
import type { OpenApiConfig } from './server/openapi'
import type { PageHook } from './server/page-hook'
import type { Redirects } from './server/redirects'
import type { Rewrite } from './server/rewrite'
import type { Prefetch } from './server/speculation'
import type { FileStore } from './server/storage'
import type { Tracer } from './server/trace'

// What `kay.config.ts` exports by default; `pages()`, `kay build`, `kay dev` and `kay check` all read it.
export interface KayConfig {
  // Page directory, relative to the root. Defaults to `src/routes`.
  routes?: string | undefined
  // Elysia modules mounted under `/api` by their path, relative to the root: `src/api/chat.ts` serves `/api/chat`. Defaults to `src/api`.
  api?: string | undefined
  // The path the API modules, the OpenAPI document and its reference page are served under, `/api` by default: `apiPath: '/v1'` serves `src/api/chat.ts` at `/v1/chat`. Absolute, plain segments, no trailing slash, not under `/_kay`; `mcp.path` and the `openapi` paths keep their own settings. Libraries read it through `apiUrl()`.
  apiPath?: string | undefined
  // Files served as they are at their path, relative to the root. Defaults to `public`.
  publicDir?: string | undefined
  // How long a browser keeps a file of `public/` without asking again, by the path it is served at, as a glob: `{ '/fonts/**': '365d', '**/*.png': '30d' }`; the first pattern a path matches decides, and a file none names keeps revalidating through its ETag on every visit. Ignored by `kay dev`, so an edit shows at once.
  publicCache?: Record<string, Duration> | undefined
  minify?: boolean | undefined
  lang?: string | undefined
  // The origin the site is public at, `https://example.com`: canonical links, social URLs and the sitemap are built from it. `SITE_URL` when left out, so one build serves each host it is deployed to; a `site` written here wins over `SITE_URL`.
  site?: string | undefined
  seo?: SeoConfig | undefined
  // What `/robots.txt` says besides pointing at the sitemap, or `false` to serve none: `{ disallow: ['/admin'] }`. Needs `site`, as the sitemap does.
  robots?: RobotsConfig | false | undefined
  // Tags every page's head carries, written as a `head` block compiles them: `[{ tag: 'script', props: { src: '/stats.js', defer: true } }]`, a tag's text as `children`. A layout or the page setting a tag of the same identity wins, and the content security policy lets their inline scripts and styles through.
  head?: HeadTag[] | undefined
  images?: ImagesConfig | undefined
  // The most a page may load, compressed: `{ js: '20kb', css: '10kb' }` for its scripts and stylesheets, `weight: '500kb'` for the whole page and `grade: 'C'` for the worst EcoIndex grade it may have. `kay build` reports each page over it with `over-budget`, naming the modules weighing most for `js` and `css`; a key left out sets no limit, and with none nothing is checked.
  budget?: BudgetConfig | undefined
  // A square image, relative to the root, 512 pixels wide or more for sharp icons, a smaller one enlarged with a warning: kay serves it as `/favicon.ico`, `/apple-touch-icon.png` and the icons of `/manifest.webmanifest`, linked from every page. `{ image, svg }` adds an SVG of it, served as `/favicon.svg` and linked after the ICO; a square SVG alone is both, every icon drawn from it. Defaults to kay's own mark; `false` serves none.
  favicon?: string | FaviconConfig | false | undefined
  // The web manifest served with the favicon, named after `seo.name` and described by `seo.description`.
  manifest?: ManifestConfig | undefined
  // The server entry, relative to the root, `src/server.ts` by default: what `kay dev`, `start`, `render`, `check` and `build` run and type against, unless `--entry` names another. With no file there, kay's own server of the pages.
  entry?: string | undefined
  // A service worker keeping the build's files and some pages for a visitor offline, `true` or what it keeps; off by default, as `false` is.
  offline?: true | OfflineConfig | false | undefined
  // `true` has `kay build` index the text of the pages it renders, which `searchSite()` from `kay` searches in the browser; off by default.
  search?: boolean | undefined
  // Self-hosted fonts, declared on every page and preloaded where they ask for it.
  fonts?: (FontConfig | FontsourceConfig)[] | undefined
  // The security headers every response carries, or `false` for none; a header the app sets itself wins.
  security?: SecurityConfig | false | undefined
  // The proxies in front of the server, `true` for one and a number for that many, which the client's address that rate limits count is read through. Without it, or with `false`, the address the server was reached from is the client, so behind a proxy every visitor counts as that proxy.
  proxy?: ProxyConfig | number | boolean | undefined
  // The most a request with a body to any route may send (`maxSize`), bytes or a size such as `'4mb'`, 1 MB by default; an action or an `api()` module raises or lowers it for itself. A bigger one answers 413 before it is read.
  maxSize?: ByteSize | undefined
  // The most a request to a route of your own (`new Elysia().post()`) may send, by path: the route itself and what is under it, bytes or a size such as '50mb', in place of `maxSize`. The path is the one the server routes, without the `base`.
  maxSizes?: Record<string, ByteSize> | undefined
  // Every page, action, endpoint and API module of the app answers 403 unless a `_guard.ts` covers it or it sets `guards: false`, in its `page` or its `api()` options; `kay check` reports each such route. A library's routes keep the guards it gives them.
  requireGuards?: boolean | undefined
  // Lets other sites' pages call every API module's routes from the browser, as `api({ cors })` does for one: `cors: { origins: ['https://app.example.com'], credentials: true }`. A module setting its own `cors` keeps it, and `api({ cors: false })` keeps a module to its own site.
  cors?: CorsOptions | undefined
  // Serves an OpenAPI 3.1 document of the API modules' routes at `/api/openapi.json`, or at `openapi: { path }`, read from their schemas, behind the API directory's own `_guard.ts`; `{ reference: true }` adds a page listing them at `/api/reference`, or at `referencePath`, `{ dev: true }` keeps both to `kay dev`.
  openapi?: boolean | OpenApiConfig | undefined
  // Serves an MCP endpoint at `/mcp` over Streamable HTTP, or at `mcp: { path: '/tools' }`, for an agent to call the app: a tool per API route that sets `tool` in its `detail`, and per action that sets `tool` on its protection. A call runs through the same guards, rate limits and `ctx.locals` as a fetch would.
  mcp?: boolean | McpConfig | undefined
  // Compresses the pages rendered per request, action results, and any Response the app's routes registered after `pages()` return, with brotli or gzip. On by default when NODE_ENV is production; `false` behind a proxy or CDN that compresses already.
  compress?: boolean | undefined
  // A server build with a prerendered page uses its 404 page as a compression dictionary, sending a page to a browser that fetched it as the difference from it; `false` builds none, so no page names it and the build writes no `.dcz` copy.
  compressionDictionary?: boolean | undefined
  // The route a load balancer or a container polls, `/_kay/health` unless `path` names another, or `false` for none.
  health?: HealthConfig | false | undefined
  // Serves `/metrics` in the Prometheus text format for a collector: requests by method, route and status, their durations, scheduled runs, cache reads and live connections. Read only from this machine or a private network by a request no proxy forwarded, or from anywhere with the `Authorization: Bearer` token `KAY_METRICS_TOKEN` holds; `{ path }` moves it. Off by default, and under `kay dev`.
  metrics?: boolean | MetricsConfig | undefined
  // Serves a page of the app's queues at `/_kay/jobs` in production: each queue's waiting, running and failed jobs with payload and error, and a button to retry or delete one. It mounts only with a `guard`, a kay guard or a list of them such as `ctx => ctx.locals.auth.requireAdmin()`, which runs on every request, and without one the boot stops. `{ path }` moves it. Off by default, and under `kay dev`, whose dev tool has a Jobs tab.
  jobs?: JobsConfig | undefined
  // One line per request on stdout, on by default when NODE_ENV is production, `false` for none; `'json'` writes it and kay's own messages as one JSON object each instead, and a function receives them all.
  log?: Logger | undefined
  // A `Server-Timing` header on each page rendered per request, timing its guards, the import of its modules, its loads and its render for the browser's network panel: on in development, off otherwise unless set.
  serverTiming?: boolean | undefined
  // An OpenTelemetry tracer, `trace.getTracer('my-site')` from @opentelemetry/api: a span per page request with one per load and the render in it, and one per API request. None by default, which costs nothing.
  tracer?: Tracer | undefined
  // Serves a request from another path, query included, such as a host's pages from a section: `url => url.hostname === 'blog.example.com' ? `/blog${url.pathname}` : undefined`. The browser keeps its URL.
  rewrite?: Rewrite | undefined
  // Old paths sent elsewhere with a 308, or a 307 with `permanent: false`, or the 301 or 302 older clients and some crawlers expect with `status`: `{ '/blog/:slug': '/posts/:slug', '/docs/*': '/guide/*', '/old': { to: '/new', status: 301 } }`. `kay check` reports a target no page serves.
  redirects?: Redirects | undefined
  // The hosts besides the site's own that a redirect added while the site runs, from a library's screen or `kay not-found --runtime`, may send to: `{ hosts: ['example.org'] }`. None by default, which keeps an editor's redirect on the site.
  runtimeRedirects?: { hosts?: string[] | undefined } | undefined
  // What the live values' connections may cost one client address: how many at once and how many opened a minute.
  live?: LiveConfig | undefined
  // The header a request's id comes in on from a trusted proxy and goes out on, `x-request-id` by default: `'x-correlation-id'`.
  requestIdHeader?: string | undefined
  // The locales pages are served in, each under its prefix or on its own domain, with messages in `src/messages/<locale>.ts`.
  i18n?: I18nConfig | undefined
  // The IANA time zone dates are written in, `Europe/Paris`: `formatDate` and the dates of kay's own screens, on the server and in the islands alike, unless a call names its own `timeZone`. The server's and the visitor's zone by default.
  timeZone?: string | undefined
  // Where the site is mounted when not at its host's root, `/docs`: the links, assets, forms and redirects pages render, the sitemap and the feeds carry it, links stay written without it, and a proxy in front of the server takes it off requests.
  base?: string | undefined
  // Where a link leaving the site opens: kay adds `target="_blank" rel="noopener"` to an `a` whose href is another origin, in templates, islands, Markdown and content bodies, unless the element sets its own `target`. `{ outside: 'same-tab' }` writes none.
  // `schemes` lists the URL schemes the app trusts in a bound `href`, `src`, `action`, `formaction`, `xlink:href`, `poster` or `data`, `['webcal', 'geo']`: any other scheme but the web's, mail, phone, sms and blob goes out as `unsafe:`, as `javascript:` would. `javascript`, `vbscript` and `data` are refused. `kay dev` logs each bound URL it rewrote.
  links?: { outside?: 'new-tab' | 'same-tab' | undefined, schemes?: string[] | undefined } | undefined
  // Whether a page's URL ends with a slash: `never`, the default, redirects `/about/` to `/about`; `always` the other way; `ignore` serves both.
  trailingSlash?: TrailingSlash | undefined
  // The module exporting the project's content collections, `src/content.config.ts` by default; their folders are relative to it.
  content?: string | undefined
  // How every collection's Markdown compiles; a collection's own option of the same name wins.
  markdown?: MarkdownConfig | undefined
  // How long a stopping server gives open requests and streams to finish before closing them, a string such as '30s'; 10 seconds by default.
  shutdownTimeout?: Duration | undefined
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
  // When the browser fetches a page a link points at before it is followed: `moderate`, the default, on hover. A link with `data-no-prefetch` never is.
  prefetch?: Prefetch | undefined
  // Whether a visitor sending `Save-Data: on` gets a lighter site by itself: image variants one width narrower, no font preloads, fonts shown only when cached, no speculation rules; `Save-Data` or `prefers-reduced-data` in the browser also stops the prefetch and has an island with no `hydrate` wait until it scrolls near. On by default, `false` serves everyone alike.
  saveData?: boolean | undefined
  // Bun plugins the browser build runs, such as Tailwind's.
  plugins?: BunPlugin[] | undefined
  // The app's own module for a kay library's settings, by the library's name: `{ '@kaynooo/kayjs-ui': './src/ui-settings.ts' }`. It replaces the module the library's package.json names as `"kay": { "settings" }`, on the server and in islands alike.
  settings?: Record<string, string> | undefined
  // The level of each lint `kay check`, `kay build`, `kay dev` and the editor report, or of each lint in a group, over its default: `{ 'positional-key': 'deny', 'seo': 'deny', 'unread-name': 'warn' }`. `kay explain` lists them.
  lints?: LintLevels | undefined
  // The app's one secret, at least 32 random characters: it seals `session()`'s cookie, signs form stamps, links to private files and the flash cookie, and gives `preview` its key, each under a key derived for its use. `KAY_SECRET` alone does the same, so this is for a secret kept elsewhere than the environment. A list, or commas in `KAY_SECRET`, rotates it: the first seals and signs, every one opens and verifies: sessions, kayjs-auth's sealed data, stamps, private-file links, the flash cookie and preview links, so a rotation breaks none of them. A `session()` called as a module loads reads `KAY_SECRET` only, as the config is not read yet, so a secret meant for sessions goes in `KAY_SECRET`. Development and tests derive one for the checkout; production without any refuses to boot a `session()`, and a production server using none refuses to start, as it would sign with a key of the process, which a restart changes and other replicas do not share; `KAY_EPHEMERAL_SECRET=1` starts it anyway, for a single throwaway server.
  secret?: string | string[] | undefined
  // Lets an editor see drafts on the live site, `false` for none: a visitor in preview mode sees every draft, and pages render for them alone, past prerendered and cached copies.
  preview?: PreviewConfig | false | undefined
  // Where `files` from `kay/server` keeps what it stores: `diskFiles('data/files')` by default, `s3Files()` for a bucket, or memory under `bun test`.
  storage?: FileStore | undefined
  // Where the app keeps what outlives one process, for every feature naming no store of its own: `session()`'s data, `cached` values, `live()` values, queued jobs and schedule locks, rate limit counts, the tabs a page's `presence()` lists and the Web Vitals `vitals()` counts and the notifications `notify()` stores. `sqliteData('data/app.sqlite')` keeps them all in one file; `{ sessions, cache, live, jobs, rates, rooms, vitals, notifications }` takes stores of your own, each optional, Redis say. Without it sessions travel in their cookie, jobs stay in `data/jobs.sqlite` and the others in memory.
  store?: AppStore | undefined
  // Receives every error a load, a render, a guard or an action throws, as it is logged, and the ones islands report from the browser: the place to send them to an error tracker.
  // An error met outside any request, in a scheduled or background job or an `onStop` hook, comes with `undefined` for the request.
  onError?: ((event: { error: unknown, request: Request | undefined }) => void | Promise<void>) | undefined
  // The files `kay env` and `kay check` compare the declared variables with: a compose file or several, and the example env file (`{ compose: 'compose.prod.yaml', example: '.env.example' }`). Each variable production needs must be set by a compose service and listed in the example, and each one the example lists must be declared. `false` turns the comparison off, the default one against the root compose files and `.env.example` included.
  env?: { compose?: string | string[] | undefined, example?: string | undefined } | false | undefined
  // The app's own checks, which `kay check` runs with its own: each gets `{ root, routes, report }` and reports problems with `report({ level, message, file, line })`, which join kay's in every format and count toward the exit code. A check that throws, or does not finish within 30 seconds, is reported as an error and the others still run.
  checks?: ProjectCheck[] | undefined
  // What libraries add to the app, each listed once: `extensions: [auth()]`.
  extensions?: KayExtension[] | undefined
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
}

export interface LiveConfig {
  // How many live connections one client address holds at once, 20 by default: a few tabs, not a flood. One more answers 429.
  connections?: number | undefined
  // How many it may open in a minute, 120 by default.
  perMinute?: number | undefined
}

export interface JobsConfig {
  guard: Guard | Guard[]
  path?: string | undefined
}

export interface MetricsConfig {
  path?: string | undefined
}

export interface HealthConfig {
  path?: string | undefined
  // How long `check` may take before the route fails with 503, and how long `--health` waits for the route: a string such as `'250ms'` or `'10s'`; 5 seconds by default.
  timeout?: Duration | undefined
  // Fails the route with 503 when it returns false or throws, such as a database that does not answer.
  check?: (() => unknown) | undefined
}

export interface SecurityConfig {
  // Directives merged over kay's Content-Security-Policy, `{ 'img-src': ["'self'"] }`, one given `false` left out, or `false` for no policy; `script-src` keeps the hashes of kay's inline scripts.
  csp?: Record<string, string[] | false> | false | undefined
  // Directives merged over the enforced policy and sent as `Content-Security-Policy-Report-Only`, to see what a stricter policy would block before enforcing it.
  reportOnly?: Record<string, string[] | false> | undefined
  // Where browsers report what either policy blocks: `true` for kay's own route, which logs each violation and hands it to `onError` as a `CspViolationError`, or a collector's URL.
  reports?: true | string | undefined
  // Features merged over kay's Permissions-Policy, which refuses camera, microphone, geolocation, payment, usb and browsing-topics: `{ microphone: 'self' }`, `{ geolocation: ['self', 'https://maps.example.com'] }` or `{ camera: '*' }`, one given `false` left out of the policy. A `permissions-policy` in `headers` still replaces the whole header.
  permissions?: Record<string, string | string[] | false> | undefined
  // Headers merged over kay's, one given `false` not sent: `{ 'strict-transport-security': 'max-age=63072000; includeSubDomains' }`.
  headers?: Record<string, string | false> | undefined
  // Production answers 421 to a request whose `Host` is not the site's, one of the `i18n` locale hosts or listed here, against DNS rebinding: `true` allows those alone. Localhost and IP addresses always pass, as a health check reaches the server by them. Off by default, and under `kay dev`, which has `KAY_DEV_HOSTS`.
  hosts?: string[] | true | undefined
}

// `hops` or `header`, not both, and with `key` alone one proxy is in front: read only from a request coming from this machine or a private network, so a client reaching the server directly cannot forge it.
export interface ProxyConfig {
  // The proxies that each append to `X-Forwarded-For`: 1 for nginx or Caddy alone, 2 for Cloudflare then nginx.
  hops?: number | undefined
  // The header a proxy sets to the client's address, such as `cf-connecting-ip` or `x-real-ip`, read instead of `X-Forwarded-For`.
  header?: string | undefined
  // The public address ranges the proxy reaches the server from, such as a CDN's published ones, `173.245.48.0/20`: trusted besides this machine and private networks.
  trusted?: string[] | undefined
  // `false` trusts the `trusted` ranges alone, instead of this machine and private networks too: for a server whose private neighbours are not all its proxies. Goes with `trusted`.
  trustPrivate?: false | undefined
  // The header the proxy sends with a key it shares with the server, such as `x-upstream-key`: a request without it, or with another value, is refused with 403, so a process or a container reaching the port directly skips nothing the proxy does. The key is read from `KAY_PROXY_KEY`, else from the file `KAY_PROXY_KEY_FILE` names, and compared in constant time. Off under `kay dev` and outside production without a key; a production server with none does not boot.
  key?: string | undefined
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
  // The older spelling of `subsets`, which also takes one name.
  subset?: string | string[] | undefined
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
  // Also every page's `theme-color`, unless `seo.themeColor` sets one.
  themeColor?: string | undefined
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
  // Whether a heading links to its own anchor, on by default; `false` leaves the heading's text plain, with its id.
  headingLinks?: boolean | undefined
  // Words a minute an entry's `readingTime` counts at, 230 by default.
  readingSpeed?: number | undefined
  // The `sizes` of the relative images in Markdown bodies, `100vw` unless set: how wide they show, such as `(min-width: 60rem) 40rem, 100vw`. An image's own `sizes` attribute wins.
  imageSizes?: string | undefined
}

export interface ImagesConfig {
  // Directories of images added at runtime, such as uploads, by the URL path the app serves them at: `{ '/uploads/': 'data/uploads' }`. The image route resizes those as well as imported images, reading them on each request; a directory is relative to the root, or where an executable runs.
  dirs?: Record<string, string> | undefined
  // Hosts whose images are resized too, each an origin and maybe a path, its host maybe starting with `*.` for any subdomain: `['https://cms.example.com/uploads/', 'https://*.cdn.example.com']`. The image route downloads them, keeping a copy it revalidates; a host not listed is refused, so the route is no open proxy.
  remote?: string[] | undefined
  // The most a remote original may weigh, bytes or a size such as `'10mb'`: a bigger one answers 413 and is not kept. 25 MB by default.
  remoteMaxSize?: ByteSize | undefined
  // How long the image route waits for a remote host, redirects included, a string such as `'30s'`; 10 seconds by default. A slower host answers 502.
  remoteTimeout?: Duration | undefined
  // WebP quality, 1 to 100. Defaults to 80. It also sets the quality of the share cards' JPEG, which `webp.quality` leaves alone; `image(src, { quality })` sets one image's variants.
  quality?: number | undefined
  // WebP variants beside the AVIF ones: `{ quality: 75 }` over `quality`, for the variants alone.
  webp?: { quality?: number | undefined } | undefined
  // The widths in pixels `image()` resizes to and the route makes, whole numbers from 1 to 16384, at most 16, in any order: `[480, 960, 1440, 1920]`. Defaults to `[320, 640, 960, 1280, 1920, 2560]`, and no variant is wider than the last width, which a list of your own does not do: it also gets each image's own size. Each width is a file per image, so a short ladder builds fewer.
  widths?: number[] | undefined
  // AVIF variants beside the WebP ones, a third to a half smaller, sent to a browser whose `Accept` names `image/avif`: on at quality 50 by default, `false` serves WebP alone. Development and a static export serve WebP.
  avif?: false | { quality?: number } | undefined
  // The most pixels per CSS pixel an image loads at on a denser screen, at least 1. Defaults to 2: a 3x phone loads what a 2x one does, which looks the same; `Infinity` leaves the browser's choice.
  maxDensity?: number | undefined
  // `false` leaves out the color an image's box shows until it loads, which kay reads off each imported, Markdown, `dirs` and `remote` image without transparency; `image(src, { placeholder: false })` and `no-placeholder` on an `img` leave out one image's. Shown as a `style` attribute, so a CSP without `'unsafe-inline'` for styles drops it.
  placeholder?: false | undefined
  // The aspect ratios `image(src, { aspect })` may cut to, each one adding a variant per width the route makes on request: `['1/1', '3/2', '2/3', '4/3', '3/4', '16/9', '9/16']` by default.
  aspects?: string[] | undefined
  // How `shareCard()` draws a page's card.
  card?: CardConfig | undefined
  // The file of an image `src` no import, stored file, `dirs` entry or remote host names, looked up the app's own way: `(src, ctx) => mediaPath(src.slice('/media/'.length))`. A path relative to the root, or undefined for a 404; `ctx` is a guard's, its `deny()` and `redirect()` included. `image(src, { width, height })` then resizes any `src` starting with `/`, and these answers are private to the browser.
  resolve?: ((src: string, ctx: GuardContext) => string | undefined | Promise<string | undefined>) | undefined
  // Run before `resolve`, as a page guard: `guard(ctx => { if (!ctx.locals.session.get('user')) ctx.deny(401) })` resizes those images for signed-in users alone.
  guard?: Guard | undefined
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

export interface I18nConfig {
  // BCP 47 tags, `['fr', 'en']`.
  locales: string[]
  defaultLocale: string
  // The default locale under its prefix too, `/fr/about`; an unprefixed path then redirects to the visitor's locale, from their cookie or their browser's languages. Off by default, the default locale's pages unprefixed.
  prefixDefault?: boolean | undefined
  // Each locale's host, `{ fr: 'example.fr', en: 'example.com' }`, in place of prefixes; a host not listed serves the default locale.
  domains?: Record<string, string> | undefined
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
export interface KayExtension<Server extends AnyElysia = AnyElysia> {
  name: string
  // Set when the extension does nothing without a running server, as a tracker posting to a route of its own: `kay build --static` warns of it, as that export runs no extension's server.
  needsServer?: boolean | undefined
  // Set when the extension counts visitors only after their yes on the `kay_analytics` cookie, so another extension measuring visitors, such as `vitals()`, waits for the same yes.
  asksConsent?: boolean | undefined
  // The most a request to the extension's routes may send, by path: the route itself and what is under it, bytes or a size such as '8mb', in place of the app's `maxSize` that every other route with a body has.
  maxSize?: Record<string, ByteSize> | undefined
  // Files a static export writes into the site, by their path, for what the extension's server would otherwise serve as a constant, such as a script every page loads: `kay build --static` runs no server plugin.
  staticFiles?: Record<string, string> | undefined
  // An Elysia plugin `pages()` uses before the pages, actions and API modules, so its derives reach their `ctx.locals` and `kay check` types them; scoped or global hooks reach them, local ones only the plugin's own routes.
  // Given as a function, it is called only when `pages()` builds the app, never when `kay check`, the editor or `kay build` read the config: the way to hand a plugin built on a database or the server's environment.
  server?: Server | ((app: ExtensionApp) => Server | Promise<Server>) | undefined
  // Optional files of the app the extension reads, by the name it reads them by and their path under the project root: `{ hooks: 'src/auth.ts' }`. kay imports each one that exists as the server starts and hands the modules to a `server` function as `app.modules` (undefined for a file the app has not written), bakes them into an executable `kay build --compile` makes, and reloads them under `kay dev` when one is edited, added or removed. Only a `server` function and the API modules of `api` exporting a function receive the modules, though every file is baked and reloaded. A path outside the project root stops the server.
  appFiles?: Record<string, string> | undefined
  // The server plugin named by the module that exports it, `{ path: './src/auth', export: 'auth' }` for `export const auth` (`default` by default): imported only as `pages()` builds the app, and baked into an executable `kay build --compile` makes, which a path built at run time inside a library could not be. The export is the plugin, a function building it, or an object carrying it as `plugin`, as a library's `createAuth` result does. `kay check` types the locals off the module itself, and off the extension's `Server` argument when it has one; used beside `server`, the module wins. A path is relative to the project root. `prepare` runs with the export before the plugin is taken from it, for a library to hand the app's module what the extension was given; a throw stops the server.
  serverModule?: { path: string, export?: string | undefined, prepare?: ((exported: unknown) => void | Promise<void>) | undefined } | undefined
  // Config laid under the app's `kay.config.ts`: objects merged key by key, arrays joined with the extension's items first, any other value the app sets winning. Bun plugins the library's files need go in its `plugins`.
  config?: Omit<KayConfig, 'extensions'> | undefined
  // A directory of `.kay` pages, layouts and guards laid over the app's routes under `prefix`, the root by default: a file of the app at the same path replaces the library's.
  // Its directories are absolute, as a library gives them from `import.meta.dir`, or relative to the project root.
  routes?: { dir: string, prefix?: string | undefined } | undefined
  // A `.kay` layout wrapping every page outside the app's own layouts, rendering its `slot` and then what the library mounts on every page, as a toaster: absolute or relative to the project root, and alone in its directory. A page or layout setting `layouts: false` starts afresh without it. `{ file, reaching }` wraps only the pages whose import graph (the page, its layouts and every `.kay` file and app script they import, however deep) reaches one of the `reaching` files, so a library needing per-request data on the first bytes pays for it only where its components are used.
  layout?: string | { file: string, reaching: string[] } | undefined
  // Stylesheets the app's own stylesheets may `@apply` utilities from and read `theme()` tokens of with no `@reference` line, as if each began with one: absolute paths, or specifiers Tailwind resolves from the stylesheet. kay adds an `@reference` after the Tailwind import of each stylesheet of the app, which writes no rule, so a stylesheet that already imports or references the file is not loaded twice.
  references?: string[] | undefined
  // A module whose default export is `defineContext(load)` from `kay/library`, absolute or relative to the project root: `load(request)` returns the request values the extension gives every template as `ctx`, `ctx.user` or `ctx.can('admin')`, with no `--- server` fence. It runs at most once per request, ahead of the render of each page whose imports reach a template that reads `ctx`, and of no other, which is then the visitor's own as a page reading `ctx.locals` is. `defineContext({ key: load })` gives one loader per key instead, each run only for a page whose templates read that key. `kay check` and the editor type `ctx` off the module itself; two extensions giving one key stop the page.
  context?: string | undefined
  // A directory of API modules laid over the app's under `prefix`, the root by default, as `routes` is over its pages: `{ dir: 'api', prefix: 'auth' }` serves `api/session.ts` at `/api/auth/session`, unless the app has `src/api/auth/session.ts`.
  // A prefix starting with `/_kay/` is absolute, served there whatever `apiPath` is. `former` is the prefix it had under `apiPath` before it moved: that path still answers, as the new one, for the releases the library says.
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

export const CONFIG_FILE = 'kay.config.ts'

// The nested bags whose own keys are checked as the config's are, by the key holding them and the shape they take.
interface NestedBags {
  security: SecurityConfig
  i18n: I18nConfig
  seo: SeoConfig
  offline: OfflineConfig
  health: HealthConfig
  proxy: ProxyConfig
}

// The known key a mistyped one differs from by its case alone, which a type can tell; `kay check` names the nearest by distance.
type CaseVariant<Key, Known> = { [Name in keyof Known & string]: Lowercase<Name> extends Lowercase<Key & string> ? Name : never }[keyof Known & string]

// What an unknown key's value must be: a string naming the problem, which nothing a config gives matches, so the error lands on the key.
type Misspelled<Key, Known> = [CaseVariant<Key, Known>] extends [never] ? 'unknown option' : `unknown option, did you mean \`${CaseVariant<Key, Known> & string}\`?`

type UnknownKeys<Given, Known> = Given extends object ? { [Key in Exclude<keyof Given, keyof Known>]: Misspelled<Key, Known> } : unknown

// The config with every key `KayConfig` and its nested bags lack typed so that setting it is an error: an inferred type parameter gets no excess property check of its own.
type Checked<Config> = UnknownKeys<Config, KayConfig> & { [Key in keyof NestedBags & keyof Config]?: UnknownKeys<Config[Key], NestedBags[Key]> }

// Gives the config back as written, so `kay check` reads the types of what it declares off it.
export function defineConfig<Config extends KayConfig>(config: Config & Checked<Config>): Config {
  return config
}

// The listed keys of the config, each one present and undefined when the config leaves it out.
export function pickConfig<Key extends keyof KayConfig>(config: KayConfig, keys: readonly Key[]): Pick<KayConfig, Key> {
  return Object.fromEntries(keys.map(key => [key, config[key]])) as Pick<KayConfig, Key>
}
