import type { BudgetConfig } from './build/budget'
import type { ActionsConfig, CardConfig, ClientConfig, CookieDefaults, DirsConfig, FaviconConfig, HealthConfig, I18nConfig, ImagesConfig, JobsConfig, KayConfig, LimitsConfig, LiveConfig, ManifestConfig, MarkdownConfig, MetricsConfig, ObserveConfig, OfflineConfig, PreviewConfig, ProxyConfig, RobotsConfig, SecurityConfig, SeoConfig, ServeConfig, SitemapConfig } from './config'
import type { Rule } from './config-rules'
import { bag, bool, bytes, duration, either, fn, isRecord, list, lit, map, num, numOrInfinity, obj, oneOf, str, typedKeys } from './config-rules'
import { nearest } from './nearest'

// Every key the config and its nested bags take, each with the check of its value, written as records so the compiler refuses a key added to a type and missing here, or listed here and gone from the type.
// A key takes `true` to accept any value while its type is too open to check; a lane adding a key to `KayConfig` adds it here, beside its type, with a check from `config-rules.ts` (`str`, `bool`, `oneOf('a', 'b')`, `list(str)`, `bag({ ... })`, `either(...)`), and a bag it holds as a `Record<keyof ItsInterface, Rule>` passed to `bag`.
const localized = either(str, map(str))
const SECURITY_KEYS: Record<keyof SecurityConfig, Rule> = { csp: either(lit(false), map(either(list(str), lit(false)))), reportOnly: map(either(list(str), lit(false))), reports: either(lit(true), str), permissions: map(either(str, list(str), lit(false))), headers: map(either(str, lit(false))), hosts: either(list(str), bool), cookies: either(lit(false), bag({ httpOnly: bool, sameSite: oneOf('lax', 'strict', 'none'), secure: either(bool, oneOf('auto')), path: str } satisfies Record<keyof CookieDefaults, Rule>)) }
const I18N: Record<keyof I18nConfig, Rule> = { locales: list(str), defaultLocale: str, prefixDefault: bool, domains: map(str), paths: map(map(str)), messages: str }
const I18N_BAG = bag(I18N, ({ locales, defaultLocale }, path, out) => {
  if (Array.isArray(locales) && typeof defaultLocale === 'string' && !locales.includes(defaultLocale))
    out.push(`\`${path}.defaultLocale\` is ${JSON.stringify(defaultLocale)}, expected one of its locales: ${locales.map(locale => JSON.stringify(locale)).join(', ')}`)
})
const SEO: Record<keyof SeoConfig, Rule> = { name: localized, titleTemplate: localized, description: localized, image: localized, imageAlt: localized, twitter: str, locale: localized, themeColor: either(str, bag({ light: str, dark: str })), jsonLd: list(obj) }
const DIRS: Record<keyof DirsConfig, Rule> = { routes: str, api: str, public: str }
const LIMITS: Record<keyof LimitsConfig, Rule> = { body: bytes, byPath: map(bytes) }
const SERVE: Record<keyof ServeConfig, Rule> = { apiPath: str, compress: bool, compressionDictionary: bool, shutdownTimeout: duration, timeout: either(duration, lit(false)) }
const OBSERVE: Record<keyof ObserveConfig, Rule> = { log: true, serverTiming: bool, requestIdHeader: str, tracer: true, extract: either(fn, lit(false)), onError: fn }
const HYDRATION = bag({ visible: str, serverIslands: str })
const CLIENT: Record<keyof ClientConfig, Rule> = { navigation: bool, inlineStyles: bool, lateStyles: bool, typography: bool, hydration: HYDRATION, prefetch: either(oneOf('conservative', 'moderate', 'eager'), lit(false)), saveData: bool, pageTimeout: duration }
const ACTIONS: Record<keyof ActionsConfig, Rule> = { protect: either(lit(false), obj), maxSize: bytes, messages: obj, beforeRun: fn, onSuccess: fn, onError: fn }
const OFFLINE: Record<keyof OfflineConfig, Rule> = { pages: list(str), fallback: str }
const HEALTH: Record<keyof HealthConfig, Rule> = { path: str, timeout: duration, check: fn }
const PROXY: Record<keyof ProxyConfig, Rule> = { hops: num, header: str, trusted: list(str), trustPrivate: lit(false), key: str, open: list(str) }
const SITEMAP: Record<keyof SitemapConfig, Rule> = { ttl: duration }
const ROBOTS: Record<keyof RobotsConfig, Rule> = { disallow: list(str), allow: list(str) }
const PREVIEW: Record<keyof PreviewConfig, Rule> = { secret: str, maxAge: duration }
const LIVE: Record<keyof LiveConfig, Rule> = { connections: num, perMinute: num }
const JOBS: Record<keyof JobsConfig, Rule> = { guard: either(fn, list(fn)), path: str }
const METRICS: Record<keyof MetricsConfig, Rule> = { path: str }
const BUDGET: Record<keyof BudgetConfig, Rule> = { js: bytes, css: bytes, weight: bytes, grade: oneOf('A', 'B', 'C', 'D', 'E', 'F', 'G') }
const FAVICON: Record<keyof FaviconConfig, Rule> = { image: str, svg: str }
const MANIFEST: Record<keyof ManifestConfig, Rule> = { shortName: str, themeColor: str, backgroundColor: str, display: oneOf('fullscreen', 'standalone', 'minimal-ui', 'browser'), orientation: oneOf('any', 'natural', 'landscape', 'landscape-primary', 'landscape-secondary', 'portrait', 'portrait-primary', 'portrait-secondary'), startUrl: str, scope: str, maskable: str, shortcuts: list(obj) }
const MARKDOWN: Record<keyof MarkdownConfig, Rule> = { highlight: fn, transform: fn, preprocess: fn, containers: bool, footnotes: bool, headingLinks: bool, readingSpeed: num, imageSizes: str }
const CARD: Record<keyof CardConfig, Rule> = { font: bag({ family: str, weight: num }), background: str, color: str, logo: str }
const IMAGES: Record<keyof ImagesConfig, Rule> = { ttl: duration, dirs: map(str), remote: list(str), remoteMaxSize: bytes, remoteTimeout: duration, quality: num, webp: bag({ quality: num }), widths: list(num), avif: either(lit(false), bag({ quality: num })), maxDensity: numOrInfinity, placeholder: lit(false), aspects: list(str), card: bag(CARD), resolve: fn, guard: fn }
const CORS = bag({ origins: either(oneOf('*'), list(str)), credentials: bool, expose: list(str), headers: list(str), maxAge: duration })
const CONFIG: Record<keyof KayConfig, Rule> = {
  dirs: bag(DIRS),
  limits: bag(LIMITS),
  serve: bag(SERVE),
  observe: bag(OBSERVE),
  client: bag(CLIENT),
  actions: bag(ACTIONS),
  beforeRequest: fn,
  onResponse: fn,
  onStart: fn,
  onStop: fn,

  i18n: I18N_BAG,
  publicCache: map(duration),
  minify: bool,
  lang: str,
  site: str,
  seo: bag(SEO),
  robots: either(lit(false), bag(ROBOTS)),
  sitemap: either(lit(false), bag(SITEMAP)),
  head: list(obj),
  images: bag(IMAGES),
  budget: bag(BUDGET),
  favicon: either(str, lit(false), bag(FAVICON)),
  manifest: bag(MANIFEST),
  entry: str,
  offline: either(lit(true), lit(false), bag(OFFLINE)),
  search: bool,
  fonts: list(obj),
  security: either(lit(false), bag(SECURITY_KEYS)),
  proxy: either(bool, num, bag(PROXY)),
  requireGuards: bool,
  cors: CORS,
  openapi: either(bool, obj),
  mcp: either(bool, obj),
  health: either(lit(false), bag(HEALTH)),
  metrics: either(bool, bag(METRICS)),
  jobs: bag(JOBS),
  rewrite: true,
  redirects: true,
  runtimeRedirects: bag({ hosts: list(str) }),
  live: bag(LIVE),
  timeZone: str,
  base: str,
  links: bag({ outside: oneOf('new-tab', 'same-tab'), schemes: list(str) }),
  trailingSlash: oneOf('never', 'always', 'ignore'),
  contentConfig: str,
  markdown: bag(MARKDOWN),
  plugins: list(obj),
  librarySettings: map(str),
  lints: true,
  secret: either(str, list(str)),
  preview: either(lit(false), bag(PREVIEW)),
  store: true,
  env: true,
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
  apiPath: 'serve.apiPath',
  compress: 'serve.compress',
  compressionDictionary: 'serve.compressionDictionary',
  shutdownTimeout: 'serve.shutdownTimeout',
  log: 'observe.log',
  serverTiming: 'observe.serverTiming',
  requestIdHeader: 'observe.requestIdHeader',
  tracer: 'observe.tracer',
  onError: 'observe.onError',
  navigation: 'client.navigation',
  inlineStyles: 'client.inlineStyles',
  lateStyles: 'client.lateStyles',
  typography: 'client.typography',
  hydration: 'client.hydration',
  prefetch: 'client.prefetch',
  saveData: 'client.saveData',
}

export const CONFIG_GROUPS = ['dirs', 'limits', 'serve', 'observe', 'client'] as const

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
