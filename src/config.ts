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
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { libraryMessageExtensions } from './build/manifests'
import { KayError } from './compiler/errors'
import { kayLog } from './runtime/log'
import { bundled, importModule } from './server/bundle'
import { publicEnvFiles } from './server/env-state'

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
  // The origin the site is public at, `https://example.com`: canonical links, social URLs and the sitemap are built from it. `SITE_URL` when left out, so one build serves each host it is deployed to; a `site` written here wins over `SITE_URL`. `ORIGIN` is read when both are unset, deprecated.
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
  // The most a request to an action or an API route may send (`maxSize`), bytes or a size such as `'4mb'`, 1 MB by default; an action or an `api()` module raises or lowers it for itself. A bigger one answers 413 before it is read.
  maxSize?: ByteSize | undefined
  /** @deprecated The old name of `maxSize`, kept three minors. */
  bodyLimit?: ByteSize | undefined
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
  // The route a load balancer or a container polls, `/_kay/health` unless `path` names another, or `false` for none.
  health?: HealthConfig | false | undefined
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
  // Where the site is mounted when not at its host's root, `/docs`: the links, assets, forms and redirects pages render, the sitemap and the feeds carry it, links stay written without it, and a proxy in front of the server takes it off requests.
  base?: string | undefined
  // Where a link leaving the site opens: kay adds `target="_blank" rel="noopener"` to an `a` whose href is another origin, in templates, islands, Markdown and content bodies, unless the element sets its own `target`. `{ outside: 'same-tab' }` writes none.
  links?: { outside?: 'new-tab' | 'same-tab' | undefined } | undefined
  // Whether a page's URL ends with a slash: `never`, the default, redirects `/about/` to `/about`; `always` the other way; `ignore` serves both.
  trailingSlash?: TrailingSlash | undefined
  // The module exporting the project's content collections, `src/content.config.ts` by default; their folders are relative to it.
  content?: string | undefined
  // How every collection's Markdown compiles; a collection's own option of the same name wins.
  markdown?: MarkdownConfig | undefined
  // How long a stopping server gives open requests and streams to finish before closing them, seconds or a string such as '30s'; 10 seconds by default.
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
  /** Variables an island may read, as `publicEnv` from `kay`: `s.Object({ MAP_KEY: s.String() })`, read from the environment as the server boots, as `defineEnv` reads its own; no other variable reaches the browser. @deprecated Since 1.70, dropped in 1.73: mark the field `s.Public` in `defineEnv` instead. */
  publicEnv?: EnvSchema | undefined
  // The level of each lint `kay check`, `kay build`, `kay dev` and the editor report, or of each lint in a group, over its default: `{ 'positional-key': 'deny', 'seo': 'deny', 'unread-name': 'warn' }`. `kay explain` lists them.
  lints?: LintLevels | undefined
  // The app's one secret, at least 32 random characters: it seals `session()`'s cookie, signs form stamps, links to private files and the flash cookie, and gives `preview` its key, each under a key derived for its use. `KAY_SECRET` alone does the same, so this is for a secret kept elsewhere than the environment. A list, or commas in `KAY_SECRET`, rotates it: the first seals and signs, every one opens sessions and kayjs-auth's sealed data; stamps, private-file links, the flash cookie and preview links use the first alone, so a rotation invalidates them. A `session()` called as a module loads reads `KAY_SECRET` only, as the config is not read yet, so a secret meant for sessions goes in `KAY_SECRET`. Development and tests derive one for the checkout; production without any refuses to boot a `session()`, and a server using none signs with a key of the process, which a restart changes and other replicas do not share.
  secret?: string | string[] | undefined
  // Lets an editor see drafts on the live site, `false` for none: a visitor in preview mode sees every draft, and pages render for them alone, past prerendered and cached copies.
  preview?: PreviewConfig | false | undefined
  // Where `files` from `kay/server` keeps what it stores: `diskFiles('data/files')` by default, `s3Files()` for a bucket, or memory under `bun test`.
  storage?: FileStore | undefined
  // Where the app keeps what outlives one process, for every feature naming no store of its own: `session()`'s data, `cached` values, `live()` values, queued jobs and schedule locks, rate limit counts, the tabs a page's `presence()` lists and the Web Vitals `vitals()` counts. `sqliteData('data/app.sqlite')` keeps them all in one file; `{ sessions, cache, live, jobs, rates, rooms, vitals }` takes stores of your own, each optional, Redis say. Without it sessions travel in their cookie, jobs stay in `data/jobs.sqlite` and the others in memory.
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
  // How long a visitor stays in preview mode once in, seconds or a string such as '2h'; an hour by default.
  maxAge?: Duration | undefined
}

export interface LiveConfig {
  // How many live connections one client address holds at once, 20 by default: a few tabs, not a flood. One more answers 429.
  connections?: number | undefined
  // How many it may open in a minute, 120 by default.
  perMinute?: number | undefined
}

export interface HealthConfig {
  path?: string | undefined
  // How long `check` may take before the route fails with 503, and how long `--health` waits for the route: seconds or a string such as `'250ms'` or `'10s'`; 5 seconds by default.
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
  // Headers merged over kay's, one given `false` not sent: `{ 'strict-transport-security': 'max-age=63072000; includeSubDomains' }`.
  headers?: Record<string, string | false> | undefined
}

// `hops` or `header`, not both: read only from a request coming from this machine or a private network, so a client reaching the server directly cannot forge it.
export interface ProxyConfig {
  // The proxies that each append to `X-Forwarded-For`: 1 for nginx or Caddy alone, 2 for Cloudflare then nginx.
  hops?: number | undefined
  // The header a proxy sets to the client's address, such as `cf-connecting-ip` or `x-real-ip`, read instead of `X-Forwarded-For`.
  header?: string | undefined
  // The public address ranges the proxy reaches the server from, such as a CDN's published ones, `173.245.48.0/20`: trusted besides this machine and private networks.
  trusted?: string[] | undefined
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
  // How long the image route waits for a remote host, redirects included, seconds or a string such as `'30s'`; 10 seconds by default. A slower host answers 502.
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

// What kay hands an extension's `server` function: the root its own files (a database file, a cache) live under, and the modules of the files it named in `appFiles`.
export interface ExtensionApp {
  // The project root, or the folder an executable runs in.
  root: string
  modules: Record<string, Record<string, unknown> | undefined>
}

// What a library hands the app to list in `extensions`: pages it serves, the texts they show, the config it needs and the server plugin they run on, as if they were the app's own.
export interface KayExtension<Server extends AnyElysia = AnyElysia> {
  name: string
  // Set when the extension does nothing without a running server, as a tracker posting to a route of its own: `kay build --static` warns of it, as that export runs no extension's server.
  needsServer?: boolean | undefined
  // Set when the extension counts visitors only after their yes on the `kay_analytics` cookie, so another extension measuring visitors, such as `vitals()`, waits for the same yes.
  asksConsent?: boolean | undefined
  // Files a static export writes into the site, by their path, for what the extension's server would otherwise serve as a constant, such as a script every page loads: `kay build --static` runs no server plugin.
  staticFiles?: Record<string, string> | undefined
  // An Elysia plugin `pages()` uses before the pages, actions and API modules, so its derives reach their `ctx.locals` and `kay check` types them; scoped or global hooks reach them, local ones only the plugin's own routes.
  // Given as a function, it is called only when `pages()` builds the app, never when `kay check`, the editor or `kay build` read the config: the way to hand a plugin built on a database or the server's environment.
  server?: Server | ((app: ExtensionApp) => Server | Promise<Server>) | undefined
  // Optional files of the app the extension reads, by the name it reads them by and their path under the project root: `{ hooks: 'src/auth.ts' }`. kay imports each one that exists as the server starts and hands the modules to a `server` function as `app.modules` (undefined for a file the app has not written), bakes them into an executable `kay build --compile` makes, and reloads them under `kay dev` when one is edited, added or removed. Only a `server` function receives the modules, though every file is baked and reloaded. A path outside the project root stops the server.
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
  // A directory of API modules laid over the app's under `prefix`, the root by default, as `routes` is over its pages: `{ dir: 'api', prefix: 'auth' }` serves `api/session.ts` at `/api/auth/session`, unless the app has `src/api/auth/session.ts`.
  // A prefix starting with `/_kay/` is absolute, served there whatever `apiPath` is. `former` is the prefix it had under `apiPath` before it moved: that path still answers, as the new one, for the releases the library says.
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
  // Called with each page `kay build` prerenders, once the files it links are written and before it is compressed, and again when the server renders it afresh: returns the HTML to write.
  transformPage?: PageHook | undefined
}

// The directory of the app's own server plugins, whose files `pages()` uses before the extensions', in the order of their names.
export const PLUGINS_DIR = 'src/plugins'
const PLUGIN_FILE = /^[^_.][^.]*\.ts$/

// The file names of the app's server plugins, in the order they are used.
export function pluginFiles(root: string): string[] {
  const dir = join(root, PLUGINS_DIR)

  return existsSync(dir) ? readdirSync(dir).filter(name => PLUGIN_FILE.test(name)).sort() : []
}

// The app's `src/plugins/*.ts` as extensions carrying a server module, then the config's extensions: every server plugin `pages()` mounts, in the order it mounts them. An executable gives the `files` it was built with, as it holds no such directory.
export function serverExtensions(root: string, extensions: KayExtension[] | undefined, files = pluginFiles(root)): KayExtension[] {
  return [...files.map(name => ({ name: `${PLUGINS_DIR}/${name}`, serverModule: { path: `./${PLUGINS_DIR}/${name}` } })), ...extensions ?? []]
}

// The server plugins the extensions carry, in their order, those given as a function built now.
export async function extensionServers(extensions: KayExtension[] | undefined, root: string): Promise<{ name: string, server: AnyElysia }[]> {
  return Promise.all((extensions ?? []).flatMap((extension) => {
    const { name, server, serverModule } = extension

    if (serverModule !== undefined)
      return [(async () => ({ name, server: await serverFromModule(name, serverModule, root) }))()]

    return server === undefined ? [] : [(async () => ({ name, server: typeof server === 'function' ? await server({ root: bundled() ? process.cwd() : root, modules: await appModules(root, extension) }) : server }))()]
  }))
}

// The file of `path` under `root` that an extension names in `appFiles`, refusing one outside the root.
function appFileOf(root: string, extension: string, name: string, path: string): string {
  const file = resolve(root, path)
  const inside = relative(root, file)

  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new KayError('config-invalid', `kay: the extension ${extension} names its file ${name} as ${path}, which is not under the project root`)

  return file
}

function hasAppFile(file: string): boolean {
  const held = bundled()

  return held ? file in held.modules : statSync(file, { throwIfNoEntry: false })?.isFile() === true
}

// The files the extensions name in `appFiles`, absolute under the project root, written or not.
export function declaredAppFiles(root: string, extensions: KayExtension[] | undefined): string[] {
  return (extensions ?? []).flatMap(({ name, appFiles }) => Object.entries(appFiles ?? {}).map(([key, path]) => appFileOf(root, name, key, path)))
}

// Those of them the app has written.
export function extensionAppFiles(root: string, extensions: KayExtension[] | undefined): string[] {
  return declaredAppFiles(root, extensions).filter(file => hasAppFile(file))
}

// The modules of the files an extension names in `appFiles`, undefined for one the app has not written; an executable holds the copies its build found under the root it was built in.
export async function appModules(root: string, { name, appFiles }: Pick<KayExtension, 'name' | 'appFiles'>): Promise<ExtensionApp['modules']> {
  const base = bundled()?.root ?? root

  return Object.fromEntries(await Promise.all(Object.entries(appFiles ?? {}).map(async ([key, path]) => {
    const file = appFileOf(base, name, key, path)

    return [key, hasAppFile(file) ? await importModule<Record<string, unknown>>(file) : undefined] as const
  })))
}

// The module files the extensions name their server plugin by, as the executable holds them.
export function extensionServerModules(root: string, extensions: KayExtension[] | undefined): string[] {
  return (extensions ?? []).flatMap(({ serverModule }) => serverModule === undefined ? [] : [resolve(root, serverModule.path)])
}

// The plugin a module exports, what a function it exports builds, or the `plugin` of an object it exports; an executable reads it from the copy it holds, keyed by where the build found the file.
async function serverFromModule(name: string, { path, export: exported = 'default', prepare }: NonNullable<KayExtension['serverModule']>, root: string): Promise<AnyElysia> {
  const file = resolve(bundled()?.root ?? root, path)
  const value = (await importModule<Record<string, unknown>>(file))[exported]

  await prepare?.(value)

  const built = typeof value === 'function' ? await (value as () => unknown)() : value
  const server = typeof built === 'object' && built !== null && !('handle' in built) && 'plugin' in built ? built.plugin : built

  if (typeof server !== 'object' || server === null || !('handle' in server))
    throw new KayError('config-invalid', `kay: the extension ${name} takes its server from ${path}, which does not export an Elysia plugin as \`${exported}\``)

  return server as AnyElysia
}

// The page hooks the extensions carry, in their order.
export function pageHooks(extensions: KayExtension[] | undefined): PageHook[] {
  return (extensions ?? []).flatMap(extension => extension.transformPage === undefined ? [] : [extension.transformPage])
}

export const CONFIG_FILE = 'kay.config.ts'

// Gives the config back as written, so `kay check` reads the type of its `publicEnv` off it.
export function defineConfig<Config extends KayConfig>(config: Config): Config {
  return config
}

// `fresh` reads the file again as it is now, as `kay dev` does once it changed, rather than the module this process imported first.
export async function loadConfig(root: string, fresh = false): Promise<KayConfig> {
  return withSiteUrl(withPublicFields(root, withExtensions(withLibraryMessages(root, await importConfig(root, fresh)))))
}

const SERVER_SPECIFIER = /(['"])kay\/server\1/g
const SERVER_NAMES_IMPORT = /\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])kay\/server\3/g
const TYPE_PREFIX = /^type\s/
// Created on first use: this module is also bundled for Node, where `Bun` does not exist at load.
let sourceTranspiler: Bun.Transpiler | undefined
const transpiler = () => sourceTranspiler ??= new Bun.Transpiler({ loader: 'ts' })
// The config files read without the server: their `kay/server` import takes only `defineConfig`, which this module holds, so a process building the client or writing the types skips loading Elysia and the rest of the server.
const lightConfigs = new Set<string>()

// The config's source with its `kay/server` import pointed at this module, or undefined when it takes anything else from there.
// The imports the transpiler finds must be exactly the ones matched, so a comment, a string or a dynamic import naming the module leaves the server loaded.
function withoutServer(source: string): string | undefined {
  const named = [...source.matchAll(SERVER_NAMES_IMPORT)]

  if (named.length === 0 || named.length !== transpiler().scanImports(source).filter(({ path }) => path === 'kay/server').length)
    return undefined

  const onlyDefineConfig = named.every(([, type, names]) => type !== undefined || names!.split(',').map(name => name.trim()).filter(name => name !== '').every(name => TYPE_PREFIX.test(name) || name === 'defineConfig'))

  return onlyDefineConfig ? source.replace(SERVER_NAMES_IMPORT, statement => statement.replace(SERVER_SPECIFIER, () => JSON.stringify(import.meta.path))) : undefined
}

// A runtime plugin cannot resolve a bare specifier, so the config's source is rewritten as it loads.
// The plugin takes only this file, and only when it is light, as a loader answering nothing for a file fails and one answering for every config would keep later plugins from theirs.
// It stays registered for that one file, which the server loader's plugin also answers for.
async function readConfigLightly(file: string): Promise<void> {
  const real = realpathSync(file)

  if (lightConfigs.has(real) || withoutServer(await Bun.file(real).text()) === undefined)
    return

  lightConfigs.add(real)
  Bun.plugin({
    name: 'kay-config',
    setup(build) {
      build.onLoad({ filter: new RegExp(`^${RegExp.escape(real)}(?:\\?.*)?$`) }, async () => {
        const source = await Bun.file(real).text()

        return { contents: withoutServer(source) ?? source, loader: 'ts' as const }
      })
    },
  })
}

// The config as `kay.config.ts` writes it, its extensions' config not laid under it yet.
async function importConfig(root: string, fresh = false): Promise<KayConfig> {
  const file = join(root, CONFIG_FILE)

  if (!existsSync(file))
    return {}

  await readConfigLightly(file)

  const { default: config } = await import(fresh ? `${file}?${Date.now()}` : file) as { default?: KayConfig }

  if (typeof config !== 'object' || config === null)
    throw new KayError('config-default-export', `kay: ${CONFIG_FILE} must export its config by default: export default defineConfig({ ... })`)

  checkedConfig(config)

  return config
}

// The keys `kay check` and `kay env` read in their own way, refused when they are not the shape they take.
function checkedConfig({ checks, env }: KayConfig): void {
  if (checks !== undefined && !Array.isArray(checks))
    throw new KayError('config-invalid', `kay: \`checks\` in ${CONFIG_FILE} is a list of functions, not ${typeof checks}`)

  const notFunction = (checks ?? []).findIndex(check => typeof check !== 'function')

  if (notFunction >= 0)
    throw new KayError('config-invalid', `kay: \`checks[${notFunction}]\` in ${CONFIG_FILE} is not a function`)

  if (env === undefined || env === false)
    return

  const { compose, example } = (typeof env === 'object' && env !== null ? env : {}) as { compose?: unknown, example?: unknown }
  const files = Array.isArray(compose) ? compose : [compose]

  if (typeof env !== 'object' || env === null || Array.isArray(env) || files.some(file => file !== undefined && typeof file !== 'string') || (example !== undefined && typeof example !== 'string'))
    throw new KayError('config-invalid', `kay: \`env\` in ${CONFIG_FILE} is \`{ compose, example }\`, each a file name (\`compose\` may be a list of them), or \`false\``)
}

// The config with the catalogs of the libraries the app installs listed before its own extensions, so those and the app's messages win key by key; one an extension of the same name already brings is left alone.
function withLibraryMessages(root: string, config: KayConfig): KayConfig {
  const listed = new Set((config.extensions ?? []).filter(({ messages }) => messages !== undefined).map(({ name }) => name))
  const shipped = libraryMessageExtensions(root).filter(({ name }) => !listed.has(name))

  return shipped.length === 0 ? config : { ...config, extensions: [...shipped, ...config.extensions ?? []] }
}

// The config with each extension's own laid under it, a later extension's over an earlier one's.
function withExtensions<Config extends KayConfig>(config: Config): Config {
  const layers = (config.extensions ?? []).flatMap(extension => extension.config === undefined ? [] : [extension.config])

  if (layers.length === 0)
    return config

  return underlay(layers.reduce<KayConfig>((under, layer) => underlay(under, layer) as KayConfig, {}), config) as Config
}

// `over` merged onto `under`: plain objects key by key, arrays joined, anything else `over`'s unless it leaves it undefined.
function underlay(under: unknown, over: unknown): unknown {
  if (over === undefined)
    return under

  if (Array.isArray(under) && Array.isArray(over))
    return [...under, ...over]

  if (!isPlainObject(under) || !isPlainObject(over))
    return over

  const merged: Record<string, unknown> = { ...under }

  for (const [key, value] of Object.entries(over))
    merged[key] = underlay(under[key], value)

  return merged
}

// A schema such as `publicEnv`'s carries symbol keys a merge would drop, so it stays whole like any value built by a class.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Object.getOwnPropertySymbols(value).length > 0)
    return false

  const prototype: unknown = Object.getPrototypeOf(value)

  return prototype === Object.prototype || prototype === null
}

let warnedOrigin = false

// The site's URL the environment gives: `SITE_URL`, which the app set for kay and so fails loudly when wrong, else the deprecated `ORIGIN`, which SvelteKit's adapter-node reads and kay read before `SITE_URL`.
// `ORIGIN` is generic and other tooling sets it, so one that is no bare http(s) origin is skipped, and one that is used is told once.
export function siteFromEnv(): string | undefined {
  const { SITE_URL, ORIGIN } = process.env

  if (SITE_URL !== undefined && SITE_URL !== '')
    return SITE_URL

  const url = ORIGIN === undefined ? undefined : URL.parse(ORIGIN)

  if (url === null || url === undefined || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/' || url.search !== '' || url.hash !== '')
    return undefined

  if (!warnedOrigin) {
    warnedOrigin = true
    kayLog('warn', 'the site is public at the origin ORIGIN holds, which kay reads until 1.73 only: set SITE_URL to it instead')
  }

  return ORIGIN
}

// A project with a `s.Public` field in `src` sends the browser an environment as one with `publicEnv` does: an empty schema stands for it, as the fields themselves register as `defineEnv` reads them.
function withPublicFields<Config extends KayConfig>(root: string, config: Config): Config {
  if (config.publicEnv !== undefined || typeof Bun === 'undefined' || publicEnvFiles(root).length === 0)
    return config

  return { ...config, publicEnv: { type: 'object', properties: {} } as unknown as EnvSchema }
}

function withSiteUrl<Config extends KayConfig>(config: Config): Config {
  const site = siteFromEnv()

  return config.site !== undefined || site === undefined ? config : { ...config, site }
}

// The project's config under the options given in code; an option passed as `undefined` leaves the config's value alone rather than wiping it.
export async function withConfig<Options extends KayConfig>(root: string, options: Options): Promise<KayConfig & Options> {
  return withPublicFields(root, mergeConfig(withLibraryMessages(root, await importConfig(root)), options))
}

// `config` is as `kay.config.ts` writes it, so the extensions the options name lie under it rather than the file's.
export function mergeConfig<Options extends KayConfig>(config: KayConfig, options: Options): KayConfig & Options {
  return withSiteUrl(withExtensions({ ...config, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) } as KayConfig & Options))
}
