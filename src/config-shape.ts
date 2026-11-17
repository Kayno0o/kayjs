import type { BudgetConfig } from './build/budget'
import type { ActionsConfig, AssetsConfig, CardConfig, ClientConfig, ConfigInput, CookieDefaults, DeprecatedMcp, DeprecatedOpenApi, DeprecatedPath, DeprecatedServe, DirsConfig, EndpointsConfig, FaviconConfig, HealthConfig, I18nInput, ImageFormats, ImageLimits, ImagesInput, JobsConfig, LimitsConfig, LiveConfig, LogConfig, ManifestConfig, ManifestShareTarget, MarkdownConfig, MetricsConfig, ObserveInput, OfflineConfig, OpsConfig, PreviewConfig, ProxyConfig, RemoteImages, RobotsConfig, SecurityConfig, SeoConfig, ServeConfig, SitemapConfig } from './config'
import type { Rule } from './config-rules'
import type { McpConfig } from './server/api-modules'
import type { OpenApiConfig } from './server/openapi'
import { bag, bool, bytes, duration, either, fn, isRecord, list, lit, map, num, numOrInfinity, obj, oneOf, str, typedKeys } from './config-rules'
import { nearest } from './nearest'

// Every key the config and its nested bags take, each with the check of its value, written as records so the compiler refuses a key added to a type and missing here, or listed here and gone from the type.
// A key takes `true` to accept any value while its type is too open to check; a lane adding a key to `KayConfig` adds it here, beside its type, with a check from `config-rules.ts` (`str`, `bool`, `oneOf('a', 'b')`, `list(str)`, `bag({ ... })`, `either(...)`), and a bag it holds as a `Record<keyof ItsInterface, Rule>` passed to `bag`.
const localized = either(str, map(str))
const guardOption = either(fn, list(fn), bag({ load: fn }), lit(false))
const SECURITY_KEYS: Record<keyof SecurityConfig, Rule> = { csp: either(bool, map(either(list(str), lit(false)))), reportOnly: map(either(list(str), lit(false))), reports: either(lit(true), str), permissions: map(either(str, list(str), lit(false))), headers: map(either(str, lit(false))), hosts: either(fn, list(str), bool), cookies: either(bool, bag({ httpOnly: bool, sameSite: oneOf('lax', 'strict', 'none'), secure: either(bool, oneOf('auto')), path: str } satisfies Record<keyof CookieDefaults, Rule>)) }
const I18N: Record<keyof I18nInput, Rule> = { locales: list(str), default: str, mode: either(oneOf('prefix', 'always'), bag({ domains: map(str) })), defaultLocale: str, prefixDefault: bool, domains: map(str), paths: either(fn, map(map(str))), messages: str }
const I18N_BAG = bag(I18N, ({ locales, default: named, defaultLocale }, path, out) => {
  const chosen = named ?? defaultLocale

  if (Array.isArray(locales) && typeof chosen === 'string' && !locales.includes(chosen))
    out.push(`\`${path}.${named === undefined ? 'defaultLocale' : 'default'}\` is ${JSON.stringify(chosen)}, expected one of its locales: ${locales.map(locale => JSON.stringify(locale)).join(', ')}`)
})
const SEO: Record<keyof SeoConfig, Rule> = { name: localized, titleTemplate: localized, description: localized, image: localized, imageAlt: localized, noindex: bool, twitter: str, locale: localized, themeColor: either(str, bag({ light: str, dark: str })), jsonLd: list(obj) }
const DIRS: Record<keyof DirsConfig, Rule> = { routes: str, api: str, public: str }
const LIMITS: Record<keyof LimitsConfig, Rule> = { body: bytes, byPath: map(bytes) }
const SERVE: Record<keyof (ServeConfig & DeprecatedServe), Rule> = { apiPrefix: str, compress: bool, compressionDictionary: bool, shutdownTimeout: duration, timeout: either(duration, lit(false)) }
const LOG: Record<keyof LogConfig, Rule> = { format: oneOf('text', 'json'), requests: bool, sink: fn }
const OBSERVE: Record<keyof ObserveInput, Rule> = { log: either(bool, oneOf('json'), fn, bag(LOG)), serverTiming: bool, loadBudget: either(duration, lit(false)), requestIdHeader: str, tracer: true, extract: either(fn, lit(false)), onError: fn }
const OFFLINE: Record<keyof OfflineConfig, Rule> = { pages: list(str), fallback: str }
const LINKS = bag({ outside: oneOf('new-tab', 'same-tab'), schemes: list(str) })
const HYDRATION = bag({ visible: str, serverIslands: str })
const CLIENT: Record<keyof ClientConfig, Rule> = { navigation: bool, inlineStyles: bool, lateStyles: bool, typography: bool, hydration: HYDRATION, prefetch: either(oneOf('conservative', 'moderate', 'eager'), lit(false)), saveData: bool, pageTimeout: duration, loadingDelay: duration, offline: either(bool, bag(OFFLINE)), search: bool, links: LINKS }
const ACTIONS: Record<keyof ActionsConfig, Rule> = { protect: either(lit(false), obj), maxSize: bytes, messages: obj, beforeRun: fn, onSuccess: fn, onError: fn }
const HEALTH: Record<keyof (HealthConfig & DeprecatedPath), Rule> = { path: str, timeout: duration, check: fn }
const SECRET = either(str, bag({ env: str, file: str }))
const PROXY: Record<keyof ProxyConfig, Rule> = { hops: num, header: str, trusted: either(fn, list(str)), trustPrivate: lit(false), key: either(str, bag({ header: str, secret: SECRET })), open: list(str) }
const ENDPOINTS: Record<keyof EndpointsConfig, Rule> = { api: str, openapi: str, mcp: str, health: str, metrics: str, jobs: str }
const OPENAPI: Record<keyof (OpenApiConfig & DeprecatedOpenApi), Rule> = { title: str, version: str, path: str, reference: either(bool, bag({ path: str })), referencePath: str, dev: bool }
const MCP: Record<keyof (McpConfig & DeprecatedMcp), Rule> = { path: str, rateLimit: either(bool, obj), token: either(lit(true), SECRET), key: either(bool, str, bag({ file: str })), instructions: str }
const SITEMAP: Record<keyof SitemapConfig, Rule> = { ttl: duration }
const ROBOTS: Record<keyof RobotsConfig, Rule> = { disallow: either(fn, list(str)), allow: either(fn, list(str)) }
const PREVIEW: Record<keyof PreviewConfig, Rule> = { secret: str, maxAge: duration, sharedNotBefore: fn }
// The limit of kay's own routes: `RateLimit` but for `key`, as they count the client's address.
const KAY_ROUTE_LIMIT: Record<string, Rule> = { max: num, window: duration, store: obj, onLimit: fn }
const LIVE: Record<keyof LiveConfig, Rule> = { connections: num, rateLimit: either(bool, bag(KAY_ROUTE_LIMIT)) }
const JOBS: Record<keyof (JobsConfig & DeprecatedPath), Rule> = { guards: guardOption, guard: guardOption, path: str }
const METRICS: Record<keyof (MetricsConfig & DeprecatedPath), Rule> = { path: str, token: either(lit(true), SECRET) }
const BUDGET: Record<keyof BudgetConfig, Rule> = { js: bytes, css: bytes, weight: bytes, grade: oneOf('A', 'B', 'C', 'D', 'E', 'F', 'G') }
const FAVICON: Record<keyof FaviconConfig, Rule> = { image: str, svg: str }
const MANIFEST: Record<keyof ManifestConfig, Rule> = { shortName: str, themeColor: either(str, bag({ light: str, dark: str })), backgroundColor: str, display: oneOf('fullscreen', 'standalone', 'minimal-ui', 'browser'), orientation: oneOf('any', 'natural', 'landscape', 'landscape-primary', 'landscape-secondary', 'portrait', 'portrait-primary', 'portrait-secondary'), startUrl: str, scope: str, maskable: str, shortcuts: list(obj), shareTarget: bag({ action: str, files: list(str), params: bag({ title: str, text: str, url: str, files: str }) } satisfies Record<keyof ManifestShareTarget, Rule>) }
const MARKDOWN: Record<keyof MarkdownConfig, Rule> = { highlight: fn, transform: fn, preprocess: fn, containers: bool, footnotes: bool, headingLinks: bool, readingSpeed: num, imageSizes: str }
const CARD: Record<keyof CardConfig, Rule> = { font: bag({ family: str, weight: num }), background: str, color: str, logo: str }
const AVIF = either(bool, bag({ quality: num }))
const REMOTE_IMAGES: Record<keyof RemoteImages, Rule> = { hosts: either(fn, list(str)), maxSize: bytes, timeout: duration }
const IMAGE_FORMATS: Record<keyof ImageFormats, Rule> = { quality: num, webp: bag({ quality: num }), avif: AVIF }
const IMAGE_LIMITS: Record<keyof ImageLimits, Rule> = { variants: either(num, lit(false)), queue: either(num, lit(false)) }
const IMAGES: Record<keyof ImagesInput, Rule> = { ttl: duration, dirs: map(str), remote: either(fn, list(str), bag(REMOTE_IMAGES)), formats: bag(IMAGE_FORMATS), limits: bag(IMAGE_LIMITS), remoteMaxSize: bytes, remoteTimeout: duration, rateLimit: either(bool, bag(KAY_ROUTE_LIMIT)), maxVariants: either(num, lit(false)), queue: either(num, lit(false)), quality: num, webp: bag({ quality: num }), widths: list(num), avif: AVIF, maxDensity: numOrInfinity, placeholder: bool, aspects: list(str), card: bag(CARD), resolve: fn, guards: guardOption, guard: guardOption }
const ASSETS: Record<keyof AssetsConfig, Rule> = { images: bag(IMAGES), fonts: list(obj), favicon: either(str, bool, bag(FAVICON)), manifest: bag(MANIFEST), publicCache: map(duration) }
const OPS: Record<keyof OpsConfig, Rule> = { observe: bag(OBSERVE), health: either(bool, bag(HEALTH)), metrics: either(bool, bag(METRICS)), jobs: bag(JOBS) }
const CORS = bag({ origins: either(oneOf('*'), list(str), fn), credentials: bool, expose: list(str), headers: list(str), maxAge: duration })
const CONFIG: Record<keyof ConfigInput, Rule> = {
  dirs: bag(DIRS),
  limits: bag(LIMITS),
  serve: bag(SERVE),
  endpoints: bag(ENDPOINTS),
  assets: bag(ASSETS),
  ops: bag(OPS),
  observe: bag(OBSERVE),
  client: bag(CLIENT),
  actions: bag(ACTIONS),
  beforeRequest: fn,
  onResponse: fn,
  onListen: fn,
  onStart: fn,
  onStop: fn,
  onError: fn,

  i18n: I18N_BAG,
  publicCache: map(duration),
  minify: bool,
  lang: str,
  site: str,
  seo: bag(SEO),
  robots: either(bool, bag(ROBOTS)),
  sitemap: either(bool, bag(SITEMAP)),
  head: list(obj),
  images: bag(IMAGES),
  budget: bag(BUDGET),
  favicon: either(str, bool, bag(FAVICON)),
  manifest: bag(MANIFEST),
  entry: str,
  offline: either(bool, bag(OFFLINE)),
  search: bool,
  fonts: list(obj),
  security: either(bool, bag(SECURITY_KEYS)),
  proxy: either(bool, num, bag(PROXY)),
  requireGuards: bool,
  guards: bag({ default: oneOf('open', 'closed') }),
  cors: CORS,
  openapi: either(bool, bag(OPENAPI)),
  mcp: either(bool, bag(MCP)),
  health: either(bool, bag(HEALTH)),
  metrics: either(bool, bag(METRICS)),
  jobs: bag(JOBS),
  rewrite: true,
  redirects: true,
  runtimeRedirects: bag({ hosts: list(str) }),
  live: bag(LIVE),
  timeZone: str,
  base: str,
  links: LINKS,
  trailingSlash: oneOf('never', 'always', 'ignore'),
  contentConfig: str,
  markdown: bag(MARKDOWN),
  plugins: list(obj),
  librarySettings: map(str),
  lints: true,
  secret: either(str, list(str)),
  preview: either(bool, bag(PREVIEW)),
  store: true,
  env: true,
  envFiles: true,
  checks: true,
  extensions: list(obj),
}

// The names a config key had before 1.88 (`fileStore` before 1.87) and no longer has, each with where it lives now: one is reported as an unknown key naming its replacement.
export const REMOVED_KEYS: Record<string, string> = {
  routes: 'dirs.routes',
  api: 'dirs.api',
  content: 'contentConfig',
  storage: 'store.files',
  maxSizes: 'limits.byPath',
  settings: 'librarySettings',
  fileStore: 'store.files',
  routesDir: 'dirs.routes',
  apiDir: 'dirs.api',
  publicDir: 'dirs.public',
  maxSize: 'limits.body',
  maxSizeByPath: 'limits.byPath',
  apiPath: 'endpoints.api',
  compress: 'serve.compress',
  compressionDictionary: 'serve.compressionDictionary',
  shutdownTimeout: 'serve.shutdownTimeout',
  log: 'ops.observe.log',
  serverTiming: 'ops.observe.serverTiming',
  requestIdHeader: 'ops.observe.requestIdHeader',
  tracer: 'ops.observe.tracer',
  navigation: 'client.navigation',
  inlineStyles: 'client.inlineStyles',
  lateStyles: 'client.lateStyles',
  typography: 'client.typography',
  hydration: 'client.hydration',
  prefetch: 'client.prefetch',
  saveData: 'client.saveData',
}

// The keys the config takes at its top level, which `kay check` tells from the other options of `pages()` and `testSite()`.
export const CONFIG_KEYS: ReadonlySet<string> = new Set(Object.keys(CONFIG))

export const CONFIG_GROUPS = ['dirs', 'limits', 'serve', 'endpoints', 'observe', 'client', 'assets', 'ops'] as const

export const isBag = isRecord

const defined = (given: Record<string, unknown>): [string, unknown][] => Object.entries(given).filter(([, value]) => value !== undefined)

// The options of a code call laid over the config, each bag one level deep: `testSite({ client: { navigation: false } })` keeps the config's other `client` keys. An option left `undefined` leaves the config's value alone.
export function mergeBags(base: object, over: object): Record<string, unknown> {
  const config = base as Record<string, unknown>
  const options = over as Record<string, unknown>
  const merged = { ...config, ...Object.fromEntries(defined(options)) }

  for (const group of CONFIG_GROUPS) {
    const base = config[group]
    const over = options[group]

    if (isBag(base) && isBag(over))
      merged[group] = { ...base, ...Object.fromEntries(defined(over)) }
  }

  // `mcp` and `proxy` merge a level deep, and `proxy.key` too, so an option that gives a token or a secret keeps the path and the header the config names.
  for (const name of ['mcp', 'proxy']) {
    const base = config[name]
    const over = options[name]

    if (!isBag(base) || !isBag(over))
      continue

    const both: Record<string, unknown> = { ...base, ...Object.fromEntries(defined(over)) }

    if (isBag(base.key) && isBag(over.key))
      both.key = { ...base.key, ...Object.fromEntries(defined(over.key)) }

    merged[name] = both
  }

  return merged
}

// Each key of a config, or of one of its option bags, that no type of the config takes, as ```trailingslash`, did you mean `trailingSlash`?``; what an app mistyped would otherwise leave at kay's default with nothing said.
// A bag that is not an object is left to the checks of its own value.
export function unknownConfigKeys(config: object): string[] {
  const problems: string[] = []

  const walk = (given: Record<string, unknown>, known: Record<string, Rule>, path: string): void => {
    for (const [key, value] of Object.entries(given)) {
      if (Object.hasOwn(known, key)) {
        const inner = typedKeys(known[key])

        if (inner !== undefined && isBag(value))
          walk(value, inner, `${path}${key}.`)

        continue
      }

      const found = nearest(key, Object.keys(known))
      const removed = path === '' && Object.hasOwn(REMOVED_KEYS, key) ? REMOVED_KEYS[key] : undefined
      // A typo of a name that moved is offered with where it lives now.
      const oldName = removed === undefined && found === undefined && path === '' ? nearest(key, Object.keys(REMOVED_KEYS)) : undefined
      let hint = ''

      if (removed !== undefined)
        hint = `, moved to \`${removed}\``
      else if (found !== undefined)
        hint = `, did you mean \`${path}${found}\`?`
      else if (oldName !== undefined)
        hint = `, did you mean \`${oldName}\`, moved to \`${REMOVED_KEYS[oldName]}\`?`

      problems.push(`\`${path}${key}\`${hint}`)
    }
  }

  walk(config as Record<string, unknown>, CONFIG, '')

  return problems
}

// The leading dot a path gets from the bag walk, which starts at no key.
const LEADING_DOT = /^`\./

// Each value of a config, or of one of its option bags, that is not the kind its key takes, as ```trailingSlash` is "sometimes", expected one of "never", "always" or "ignore"; did you mean "never"?``, the key written as a path.
// A key an app set to `undefined` is left out, as the types allow it.
export function invalidConfigValues(config: object): string[] {
  const out: string[] = []

  bag(CONFIG)(config, '', out)

  return out.map(message => message.replace(LEADING_DOT, '`'))
}
