import type { BunPlugin } from 'bun'
import type { AnyElysia } from 'elysia'
import type { LintLevels } from './compiler/lints'
import type { Duration } from './runtime/duration'
import type { HeadTag } from './runtime/head'
import type { Guard, GuardContext } from './runtime/index'
import type { JsonLd } from './runtime/seo'
import type { EnvSchema } from './server/env'
import type { Logger } from './server/log'
import type { OpenApiConfig } from './server/openapi'
import type { PageHook } from './server/page-hook'
import type { Redirects } from './server/redirects'
import type { Rewrite } from './server/rewrite'
import type { Prefetch } from './server/speculation'
import type { FileStore } from './server/storage'
import type { Tracer } from './server/trace'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { KayError } from './compiler/errors'

// What `kay.config.ts` exports by default; `pages()`, `kay build`, `kay dev` and `kay check` all read it.
export interface KayConfig {
  // Page directory, relative to the root. Defaults to `src/routes`.
  routes?: string | undefined
  // Elysia modules mounted under `/api` by their path, relative to the root: `src/api/chat.ts` serves `/api/chat`. Defaults to `src/api`.
  api?: string | undefined
  // Files served as they are at their path, relative to the root. Defaults to `public`.
  publicDir?: string | undefined
  minify?: boolean | undefined
  lang?: string | undefined
  // The origin the site is public at, `https://example.com`: canonical links, social URLs and the sitemap are built from it. `SITE_URL` when left out, so one build serves each host it is deployed to.
  site?: string | undefined
  seo?: SeoConfig | undefined
  // Tags every page's head carries, written as a `head` block compiles them: `[{ tag: 'script', props: { src: '/stats.js', defer: true } }]`, a tag's text as `children`. A layout or the page setting a tag of the same identity wins, and the content security policy lets their inline scripts and styles through.
  head?: HeadTag[] | undefined
  images?: ImagesConfig | undefined
  // A square image, relative to the root, 512 pixels wide or more for sharp icons, a smaller one enlarged with a warning: kay serves it as `/favicon.ico`, `/apple-touch-icon.png` and the icons of `/manifest.webmanifest`, linked from every page. `{ image, svg }` adds an SVG of it, served as `/favicon.svg` and linked after the ICO; a square SVG alone is both, every icon drawn from it. Defaults to kay's own mark; `false` serves none.
  favicon?: string | FaviconConfig | false | undefined
  // The web manifest served with the favicon, named after `seo.name` and described by `seo.description`.
  manifest?: ManifestConfig | undefined
  // A service worker keeping the build's files and some pages for a visitor offline, `true` or what it keeps; off by default.
  offline?: true | OfflineConfig | undefined
  // `true` has `kay build` index the text of the pages it renders, which `searchSite()` from `kay` searches in the browser; off by default.
  search?: boolean | undefined
  // Self-hosted fonts, declared on every page and preloaded where they ask for it.
  fonts?: (FontConfig | FontsourceConfig)[] | undefined
  // The security headers every response carries, or `false` for none; a header the app sets itself wins.
  security?: SecurityConfig | false | undefined
  // The proxies in front of the server, which the client's address that rate limits count is read through. Without it, the address the server was reached from is the client, so behind a proxy every visitor counts as that proxy.
  proxy?: ProxyConfig | undefined
  // The most bytes a request to an action or an API route may send, 1 MB by default; an action or an `api()` module raises or lowers it for itself. A bigger one answers 413 before it is read.
  bodyLimit?: number | undefined
  // Every page, action, endpoint and API module of the app answers 403 unless a `_guard.ts` covers it or it sets `guards: false`, in its `page` or its `api()` options; `kay check` reports each such route. A library's routes keep the guards it gives them.
  requireGuards?: boolean | undefined
  // Serves an OpenAPI 3.1 document of the API modules' routes at `/api/openapi.json`, read from their schemas, behind the API directory's own `_guard.ts`; `{ reference: true }` adds a page listing them at `/api/reference`, `{ dev: true }` keeps both to `kay dev`.
  openapi?: boolean | OpenApiConfig | undefined
  // Compresses the pages rendered per request, action results, and any Response the app's routes registered after `pages()` return, with brotli or gzip. On by default when NODE_ENV is production; `false` behind a proxy or CDN that compresses already.
  compress?: boolean | undefined
  // The route a load balancer or a container polls, `/_kay/health` unless `path` names another, or `false` for none.
  health?: HealthConfig | false | undefined
  // One line per request on stdout, on by default when NODE_ENV is production, `false` for none; `'json'` writes it and kay's own messages as one JSON object each instead, and a function receives them all.
  log?: Logger | undefined
  // A `Server-Timing` header on each page rendered per request, timing its loads and its render for the browser's network panel: on in development, off otherwise unless set.
  serverTiming?: boolean | undefined
  // An OpenTelemetry tracer, `trace.getTracer('my-site')` from @opentelemetry/api: a span per page request with one per load and the render in it, and one per API request. None by default, which costs nothing.
  tracer?: Tracer | undefined
  // Serves a request from another path, query included, such as a host's pages from a section: `url => url.hostname === 'blog.example.com' ? `/blog${url.pathname}` : undefined`. The browser keeps its URL.
  rewrite?: Rewrite | undefined
  // Old paths sent elsewhere with a 308, or a 307 with `permanent: false`: `{ '/blog/:slug': '/posts/:slug', '/docs/*': '/guide/*' }`. `kay check` reports a target no page serves.
  redirects?: Redirects | undefined
  // The locales pages are served in, each under its prefix or on its own domain, with messages in `src/messages/<locale>.ts`.
  i18n?: I18nConfig | undefined
  // Where the site is mounted when not at its host's root, `/docs`: the links, assets, forms and redirects pages render, the sitemap and the feeds carry it, links stay written without it, and a proxy in front of the server takes it off requests.
  base?: string | undefined
  // Whether a page's URL ends with a slash: `never`, the default, redirects `/about/` to `/about`; `always` the other way; `ignore` serves both.
  trailingSlash?: TrailingSlash | undefined
  // The module exporting the project's content collections, `src/content.config.ts` by default; their folders are relative to it.
  content?: string | undefined
  // How long a stopping server gives open requests and streams to finish before closing them, seconds or a string such as '30s'; 10 seconds by default.
  shutdownTimeout?: Duration | undefined
  // Swaps the next page in place when a link or a form of the site is followed from a page with islands or forms posting to actions, so islands marked `persist` live on; on by default. `false` loads every page as a plain site does.
  navigation?: boolean | undefined
  // Writes each page's stylesheets into its head instead of linking them, in production: the first paint waits for no stylesheet request, while every page carries them again, since no cache keeps them.
  inlineStyles?: boolean | undefined
  // When the browser fetches a page a link points at before it is followed: `moderate`, the default, on hover. A link with `data-no-prefetch` never is.
  prefetch?: Prefetch | undefined
  // Bun plugins the browser build runs, such as Tailwind's.
  plugins?: BunPlugin[] | undefined
  // The app's own module for a kay library's settings, by the library's name: `{ '@kaynooo/kayjs-ui': './src/ui-settings.ts' }`. It replaces the module the library's package.json names as `"kay": { "settings" }`, on the server and in islands alike.
  settings?: Record<string, string> | undefined
  // Variables an island may read, as `publicEnv` from `kay`: `s.Object({ MAP_KEY: s.String() })`, read from the environment as the server boots, as `defineEnv` reads its own; no other variable reaches the browser.
  publicEnv?: EnvSchema | undefined
  // The level of each lint `kay check`, `kay build`, `kay dev` and the editor report, or of each lint in a group, over its default: `{ 'positional-key': 'deny', 'seo': 'deny', 'unread-name': 'warn' }`. `kay explain` lists them.
  lints?: LintLevels | undefined
  // Lets an editor see drafts on the live site: a visitor in preview mode sees every draft, and pages render for them alone, past prerendered and cached copies.
  preview?: PreviewConfig | undefined
  // Where `files` from `kay/server` keeps what it stores: `diskFiles('data/files')` by default, `s3Files()` for a bucket, or memory under `bun test`.
  storage?: FileStore | undefined
  // Receives every error a load, a render, a guard or an action throws, as it is logged: the place to send them to an error tracker.
  onError?: ((error: unknown, request: Request) => void | Promise<void>) | undefined
  // What libraries add to the app, each listed once: `extensions: [authPages()]`.
  extensions?: KayExtension[] | undefined
}

// What every page's head starts from; a layout or the page setting the same tag wins.
export interface SeoConfig {
  // The site's name: the title of a page that sets none, and `og:site_name`.
  name?: string | undefined
  // Wraps the title a layout or the page sets: `%s | Site`; a `title(raw)` stays as it is.
  titleTemplate?: string | undefined
  description?: string | undefined
  // The social card image, a URL or a path such as an imported asset's.
  image?: string | undefined
  // What the card image shows, for `og:image:alt` and `twitter:image:alt`.
  imageAlt?: string | undefined
  // The site's Twitter handle, `@site`.
  twitter?: string | undefined
  // `og:locale`, such as `fr_FR`.
  locale?: string | undefined
  // Structured data every page carries, such as the site's `WebSite` or `Organization`.
  jsonLd?: JsonLd[] | undefined
}

export interface PreviewConfig {
  // Signs preview links and the preview cookie, never carried in a URL: at least 32 random characters, read from the environment.
  secret: string
  // How long a visitor stays in preview mode once in, seconds or a string such as '2h'; an hour by default.
  maxAge?: Duration | undefined
}

export interface HealthConfig {
  path?: string | undefined
  // Fails the route with 503 when it returns false or throws, such as a database that does not answer.
  check?: (() => unknown) | undefined
}

export interface SecurityConfig {
  // Directives merged over kay's Content-Security-Policy, `{ 'img-src': ["'self'"] }`, one given `false` left out, or `false` for no policy; `script-src` keeps the hashes of kay's inline scripts.
  csp?: Record<string, string[] | false> | false | undefined
  // Directives merged over the enforced policy and sent as `Content-Security-Policy-Report-Only`, to see what a stricter policy would block before enforcing it.
  reportOnly?: Record<string, string[] | false> | undefined
  // Where browsers report what either policy blocks: `true` for kay's own route, which logs each violation and hands it to `onError` as a `CspViolation`, or a collector's URL.
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
  subset?: string | string[] | undefined
  display?: FontConfig['display'] | undefined
}

// A favicon with an SVG of it: kay makes the ICO and the PNG icons from `image`, and serves `svg` as it is.
export interface FaviconConfig {
  image: string
  svg: string
}

export interface ManifestConfig {
  // The name under the icon on a home screen; defaults to `seo.name`.
  shortName?: string | undefined
  // Also every page's `theme-color`.
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

export interface ImagesConfig {
  // Directories of images added at runtime, such as uploads, by the URL path the app serves them at: `{ '/uploads/': 'data/uploads' }`. The image route resizes those as well as imported images, reading them on each request; a directory is relative to the root, or where an executable runs.
  dirs?: Record<string, string> | undefined
  // Hosts whose images are resized too, each an origin and maybe a path, its host maybe starting with `*.` for any subdomain: `['https://cms.example.com/uploads/', 'https://*.cdn.example.com']`. The image route downloads them, keeping a copy it revalidates; a host not listed is refused, so the route is no open proxy.
  remote?: string[] | undefined
  // WebP quality, 1 to 100. Defaults to 80.
  quality?: number | undefined
  // AVIF variants beside the WebP ones, a third to a half smaller, sent to a browser whose `Accept` names `image/avif`: on at quality 50 by default, `false` serves WebP alone. Development and a static export serve WebP.
  avif?: false | { quality?: number } | undefined
  // The most pixels per CSS pixel an image loads at on a denser screen, at least 1. Defaults to 2: a 3x phone loads what a 2x one does, which looks the same; `Infinity` leaves the browser's choice.
  maxDensity?: number | undefined
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

// What a library hands the app to list in `extensions`: pages it serves, the texts they show, the config it needs and the server plugin they run on, as if they were the app's own.
export interface KayExtension<Server extends AnyElysia = AnyElysia> {
  name: string
  // An Elysia plugin `pages()` uses before the pages, actions and API modules, so its derives reach their `ctx.locals` and `kay check` types them; scoped or global hooks reach them, local ones only the plugin's own routes.
  // Given as a function, it is called only when `pages()` builds the app, never when `kay check`, the editor or `kay build` read the config: the way to hand a plugin built on a database or the server's environment.
  server?: Server | (() => Server | Promise<Server>) | undefined
  // Config laid under the app's `kay.config.ts`: objects merged key by key, arrays joined with the extension's items first, any other value the app sets winning. Bun plugins the library's files need go in its `plugins`.
  config?: Omit<KayConfig, 'extensions'> | undefined
  // A directory of `.kay` pages, layouts and guards laid over the app's routes under `prefix`, the root by default: a file of the app at the same path replaces the library's.
  // Its directories are absolute, as a library gives them from `import.meta.dir`, or relative to the project root.
  routes?: { dir: string, prefix?: string | undefined } | undefined
  // A directory of API modules laid over the app's under `prefix`, the root by default, as `routes` is over its pages: `{ dir: 'api', prefix: 'auth' }` serves `api/session.ts` at `/api/auth/session`, unless the app has `src/api/auth/session.ts`.
  api?: { dir: string, prefix?: string | undefined } | undefined
  // A directory of message catalogs, `<locale>.ts` each, under the app's own: a key the app translates is the app's.
  messages?: string | undefined
  // A `.kay` island every page renders at the end of its body in edit mode alone, kept alive across navigations, given `{ entries }`: each entry the page read, as `kay/edit`'s `EditorProps` types them. Absolute, or relative to the project root; one extension at most gives one.
  editor?: string | undefined
  // Called with each page `kay build` prerenders, once the files it links are written and before it is compressed, and again when the server renders it afresh: returns the HTML to write.
  transformPage?: PageHook | undefined
}

// The server plugins the extensions carry, in their order, those given as a function built now.
export async function extensionServers(extensions: KayExtension[] | undefined): Promise<{ name: string, server: AnyElysia }[]> {
  return Promise.all((extensions ?? []).flatMap(({ name, server }) => server === undefined ? [] : [(async () => ({ name, server: typeof server === 'function' ? await server() : server }))()]))
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
  return withSiteUrl(withExtensions(await importConfig(root, fresh)))
}

// The config as `kay.config.ts` writes it, its extensions' config not laid under it yet.
async function importConfig(root: string, fresh = false): Promise<KayConfig> {
  const file = join(root, CONFIG_FILE)

  if (!existsSync(file))
    return {}

  const { default: config } = await import(fresh ? `${file}?${Date.now()}` : file) as { default?: KayConfig }

  if (typeof config !== 'object' || config === null)
    throw new KayError('config-default-export', `kay: ${CONFIG_FILE} must export its config by default: export default defineConfig({ ... })`)

  return config
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

function withSiteUrl<Config extends KayConfig>(config: Config): Config {
  const { SITE_URL } = process.env

  return config.site !== undefined || SITE_URL === undefined || SITE_URL === '' ? config : { ...config, site: SITE_URL }
}

// The project's config under the options given in code; an option passed as `undefined` leaves the config's value alone rather than wiping it.
export async function withConfig<Options extends KayConfig>(root: string, options: Options): Promise<KayConfig & Options> {
  return mergeConfig(await importConfig(root), options)
}

// `config` is as `kay.config.ts` writes it, so the extensions the options name lie under it rather than the file's.
export function mergeConfig<Options extends KayConfig>(config: KayConfig, options: Options): KayConfig & Options {
  return withSiteUrl(withExtensions({ ...config, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) } as KayConfig & Options))
}
