import type { BunPlugin } from 'bun'
import type { LintLevels } from './compiler/lints'
import type { Duration } from './runtime/duration'
import type { JsonLd } from './runtime/seo'
import type { EnvSchema } from './server/env'
import type { RequestLogger } from './server/log'
import type { Redirects } from './server/redirects'
import type { Rewrite } from './server/rewrite'
import type { Prefetch } from './server/speculation'
import type { Tracer } from './server/trace'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// What `kay.config.ts` exports by default; `pages()`, `kay build`, `kay dev` and `kay check` all read it.
export interface KayConfig {
  // Page directory, relative to the root. Defaults to `src/routes`.
  routes?: string
  // Elysia modules mounted under `/api` by their path, relative to the root: `src/api/chat.ts` serves `/api/chat`. Defaults to `src/api`.
  api?: string
  // Files served as they are at their path, relative to the root. Defaults to `public`.
  publicDir?: string
  minify?: boolean
  lang?: string
  // The origin the site is public at, `https://example.com`: canonical links, social URLs and the sitemap are built from it.
  site?: string
  seo?: SeoConfig
  images?: ImagesConfig
  // A square image, 512 pixels wide or more, relative to the root: kay serves it as `/favicon.ico`, `/apple-touch-icon.png` and the icons of `/manifest.webmanifest`, linked from every page.
  favicon?: string
  // The web manifest served with the favicon, named after `seo.name` and described by `seo.description`.
  manifest?: ManifestConfig
  // Self-hosted fonts, declared on every page and preloaded where they ask for it.
  fonts?: (FontConfig | FontsourceConfig)[]
  // The security headers every response carries, or `false` for none; a header the app sets itself wins.
  security?: SecurityConfig | false
  // The proxies in front of the server, which the client's address that rate limits count is read through. Without it, the address the server was reached from is the client, so behind a proxy every visitor counts as that proxy.
  proxy?: ProxyConfig
  // The most bytes a request to an action or an API route may send, 1 MB by default; an action or an `api()` module raises or lowers it for itself. A bigger one answers 413 before it is read.
  bodyLimit?: number
  // Compresses the pages rendered per request, action results, and any Response the app's routes registered after `pages()` return, with brotli or gzip: for a server with no proxy in front doing it. Off by default.
  compress?: boolean
  // The route a load balancer or a container polls, `/_kay/health` unless `path` names another, or `false` for none.
  health?: HealthConfig | false
  // One line per request on stdout, on by default when NODE_ENV is production: `'json'` for one JSON object instead, a function to send each entry elsewhere, `false` for none.
  log?: RequestLogger
  // A `Server-Timing` header on each page rendered per request, timing its loads and its render for the browser's network panel: on in development, off otherwise unless set.
  serverTiming?: boolean
  // An OpenTelemetry tracer, `trace.getTracer('my-site')` from @opentelemetry/api: a span per page request with one per load and the render in it, and one per API request. None by default, which costs nothing.
  tracer?: Tracer
  // Serves a request from another path, query included, such as a host's pages from a section: `url => url.hostname === 'blog.example.com' ? `/blog${url.pathname}` : undefined`. The browser keeps its URL.
  rewrite?: Rewrite
  // Old paths sent elsewhere with a 308, or a 307 with `permanent: false`: `{ '/blog/:slug': '/posts/:slug', '/docs/*': '/guide/*' }`. `kay check` reports a target no page serves.
  redirects?: Redirects
  // The locales pages are served in, each under its prefix or on its own domain, with messages in `src/messages/<locale>.ts`.
  i18n?: I18nConfig
  // Where the site is mounted when not at its host's root, `/docs`: the links, assets, forms and redirects pages render, the sitemap and the feeds carry it, links stay written without it, and a proxy in front of the server takes it off requests.
  base?: string
  // Whether a page's URL ends with a slash: `never`, the default, redirects `/about/` to `/about`; `always` the other way; `ignore` serves both.
  trailingSlash?: TrailingSlash
  // The module exporting the project's content collections, `src/content.config.ts` by default; their folders are relative to it.
  content?: string
  // How long a stopping server gives open requests and streams to finish before closing them, seconds or a string such as '30s'; 10 seconds by default.
  shutdownTimeout?: Duration
  // Swaps the next page in place when a link or a form of the site is followed from a page with islands or forms posting to actions, so islands marked `persist` live on; on by default. `false` loads every page as a plain site does.
  navigation?: boolean
  // When the browser fetches a page a link points at before it is followed: `moderate`, the default, on hover. A link with `data-no-prefetch` never is.
  prefetch?: Prefetch
  // Bun plugins the browser build runs, such as Tailwind's.
  plugins?: BunPlugin[]
  // The app's own module for a kay library's settings, by the library's name: `{ '@kaynooo/kayjs-ui': './src/ui-settings.ts' }`. It replaces the module the library's package.json names as `"kay": { "settings" }`, on the server and in islands alike.
  settings?: Record<string, string>
  // Variables an island may read, as `publicEnv` from `kay`: `t.Object({ MAP_KEY: t.String() })`, read from the environment as the server boots, as `defineEnv` reads its own; no other variable reaches the browser.
  publicEnv?: EnvSchema
  // The level of each lint `kay check`, `kay dev` and the editor report, over its default: `{ 'positional-key': 'deny', 'unread-name': 'warn' }`. `kay explain` lists them.
  lints?: LintLevels
  // Receives every error a load, a render, a guard or an action throws, as it is logged: the place to send them to an error tracker.
  onError?: (error: unknown, request: Request) => void | Promise<void>
}

// What every page's head starts from; a layout or the page setting the same tag wins.
export interface SeoConfig {
  // The site's name: the title of a page that sets none, and `og:site_name`.
  name?: string
  // Wraps the title a layout or the page sets: `%s | Site`; a `title(raw)` stays as it is.
  titleTemplate?: string
  description?: string
  // The social card image, a URL or a path such as an imported asset's.
  image?: string
  // The site's Twitter handle, `@site`.
  twitter?: string
  // `og:locale`, such as `fr_FR`.
  locale?: string
  // Structured data every page carries, such as the site's `WebSite` or `Organization`.
  jsonLd?: JsonLd[]
}

export interface HealthConfig {
  path?: string
  // Fails the route with 503 when it returns false or throws, such as a database that does not answer.
  check?: () => unknown
}

export interface SecurityConfig {
  // Directives merged over kay's Content-Security-Policy, `{ 'img-src': ["'self'"] }`, one given `false` left out, or `false` for no policy; `script-src` keeps the hashes of kay's inline scripts.
  csp?: Record<string, string[] | false> | false
  // Directives merged over the enforced policy and sent as `Content-Security-Policy-Report-Only`, to see what a stricter policy would block before enforcing it.
  reportOnly?: Record<string, string[] | false>
  // Where browsers report what either policy blocks: `true` for kay's own route, which logs each violation and hands it to `onError` as a `CspViolation`, or a collector's URL.
  reports?: true | string
  // Headers merged over kay's, one given `false` not sent: `{ 'strict-transport-security': 'max-age=63072000; includeSubDomains' }`.
  headers?: Record<string, string | false>
}

// `hops` or `header`, not both: read only from a request coming from this machine or a private network, so a client reaching the server directly cannot forge it.
export interface ProxyConfig {
  // The proxies that each append to `X-Forwarded-For`: 1 for nginx or Caddy alone, 2 for Cloudflare then nginx.
  hops?: number
  // The header a proxy sets to the client's address, such as `cf-connecting-ip` or `x-real-ip`, read instead of `X-Forwarded-For`.
  header?: string
}

export interface FontConfig {
  family: string
  // A font file relative to the root, or a file of an installed package: `@fontsource-variable/inter/files/inter-latin-wght-normal.woff2`.
  src: string
  // A weight, or a range for a variable font: `100 900`. Defaults to 400.
  weight?: number | string
  style?: 'normal' | 'italic'
  // Defaults to `swap`.
  display?: 'auto' | 'block' | 'swap' | 'fallback' | 'optional'
  unicodeRange?: string
  // Fetched with the page rather than once the stylesheet asks for it; off by default, since a preload shares a slow link with the stylesheet and holds back the first paint.
  preload?: boolean
}

// Every face of a Fontsource family the site uses, its name and files read from the package.
export interface FontsourceConfig {
  // An installed package: `@fontsource/inter`, or `@fontsource-variable/inter`, whose one face per style spans every weight.
  fontsource: string
  // The weights a package of static faces declares, `[400, 600, 700]`; a variable one takes none.
  weights?: number[]
  // Defaults to `['normal']`.
  styles?: ('normal' | 'italic')[]
  // Defaults to the package's own, `latin` for most.
  subset?: string
  display?: FontConfig['display']
}

export interface ManifestConfig {
  // The name under the icon on a home screen; defaults to `seo.name`.
  shortName?: string
  // Also every page's `theme-color`.
  themeColor?: string
  backgroundColor?: string
  display?: 'fullscreen' | 'standalone' | 'minimal-ui' | 'browser'
}

export interface ImagesConfig {
  // Directories of images added at runtime, such as uploads, by the URL path the app serves them at: `{ '/uploads/': 'data/uploads' }`. The image route resizes those as well as imported images, reading them on each request; a directory is relative to the root, or where an executable runs.
  dirs?: Record<string, string>
  // Hosts whose images are resized too, each an origin and maybe a path, its host maybe starting with `*.` for any subdomain: `['https://cms.example.com/uploads/', 'https://*.cdn.example.com']`. The image route downloads them, keeping a copy it revalidates; a host not listed is refused, so the route is no open proxy.
  remote?: string[]
  // WebP quality, 1 to 100. Defaults to 80.
  quality?: number
  // The most pixels per CSS pixel an image loads at on a denser screen, at least 1. Defaults to 2: a 3x phone loads what a 2x one does, which looks the same; `Infinity` leaves the browser's choice.
  maxDensity?: number
  // The aspect ratios `image(src, { aspect })` may cut to, each one adding a variant per width the route makes on request: `['1/1', '3/2', '2/3', '4/3', '3/4', '16/9', '9/16']` by default.
  aspects?: string[]
  // How `shareCard()` draws a page's card.
  card?: CardConfig
}

export interface CardConfig {
  // The face the title is drawn in, among `fonts`: the first family listed, at the weight nearest 700 it has, by default. A variable face draws at its default weight.
  font?: { family: string, weight?: number }
  // `#rrggbb` behind a card with no image, and what an image fades into below the title: `#111111` by default.
  background?: string
  // The text's `#rrggbb`, `#ffffff` by default.
  color?: string
}

export type TrailingSlash = 'never' | 'always' | 'ignore'

export interface I18nConfig {
  // BCP 47 tags, `['fr', 'en']`.
  locales: string[]
  defaultLocale: string
  // The default locale under its prefix too, `/fr/about`; an unprefixed path then redirects to the visitor's locale, from their cookie or their browser's languages. Off by default, the default locale's pages unprefixed.
  prefixDefault?: boolean
  // Each locale's host, `{ fr: 'example.fr', en: 'example.com' }`, in place of prefixes; a host not listed serves the default locale.
  domains?: Record<string, string>
  // The directory of the `<locale>.ts` message files, relative to the root: `src/messages` by default.
  messages?: string
}

export const CONFIG_FILE = 'kay.config.ts'

// Gives the config back as written, so `kay check` reads the type of its `publicEnv` off it.
export function defineConfig<Config extends KayConfig>(config: Config): Config {
  return config
}

export async function loadConfig(root: string): Promise<KayConfig> {
  const file = join(root, CONFIG_FILE)

  if (!existsSync(file))
    return {}

  const { default: config } = await import(file) as { default?: KayConfig }

  if (typeof config !== 'object' || config === null)
    throw new Error(`kay: ${CONFIG_FILE} must export its config by default: export default defineConfig({ ... })`)

  return config
}

// The project's config under the options given in code; an option passed as `undefined` leaves the config's value alone rather than wiping it.
export async function withConfig<Options extends KayConfig>(root: string, options: Options): Promise<KayConfig & Options> {
  return mergeConfig(await loadConfig(root), options)
}

export function mergeConfig<Options extends KayConfig>(config: KayConfig, options: Options): KayConfig & Options {
  return { ...config, ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) } as KayConfig & Options
}
