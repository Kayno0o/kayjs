import type { ClientConfig, DirsConfig, HealthConfig, I18nConfig, KayConfig, LimitsConfig, ObserveConfig, OfflineConfig, ProxyConfig, SecurityConfig, SeoConfig, ServeConfig, SitemapConfig } from './config'
import { nearest } from './nearest'

// Every key the config and its nested bags take, written as records so the compiler refuses a key added to a type and missing here, or listed here and gone from the type.
const CONFIG: Record<keyof KayConfig, true> = { dirs: true, limits: true, serve: true, observe: true, client: true, routes: true, api: true, maxSizes: true, content: true, settings: true, storage: true, i18n: true, routesDir: true, apiDir: true, apiPath: true, publicDir: true, publicCache: true, minify: true, lang: true, site: true, seo: true, robots: true, sitemap: true, head: true, images: true, budget: true, favicon: true, manifest: true, entry: true, offline: true, search: true, fonts: true, security: true, proxy: true, maxSize: true, maxSizeByPath: true, requireGuards: true, cors: true, openapi: true, mcp: true, compress: true, compressionDictionary: true, health: true, metrics: true, jobs: true, log: true, serverTiming: true, tracer: true, rewrite: true, redirects: true, runtimeRedirects: true, live: true, requestIdHeader: true, timeZone: true, base: true, links: true, trailingSlash: true, contentConfig: true, markdown: true, shutdownTimeout: true, navigation: true, inlineStyles: true, lateStyles: true, typography: true, hydration: true, prefetch: true, saveData: true, plugins: true, librarySettings: true, lints: true, secret: true, preview: true, fileStore: true, store: true, onError: true, env: true, checks: true, extensions: true }
const SECURITY: Record<keyof SecurityConfig, true> = { csp: true, reportOnly: true, reports: true, permissions: true, headers: true, hosts: true, cookies: true }
const I18N: Record<keyof I18nConfig, true> = { locales: true, defaultLocale: true, prefixDefault: true, domains: true, paths: true, messages: true }
const SEO: Record<keyof SeoConfig, true> = { name: true, titleTemplate: true, description: true, image: true, imageAlt: true, twitter: true, locale: true, themeColor: true, jsonLd: true }
const DIRS: Record<keyof DirsConfig, true> = { routes: true, api: true, public: true }
const LIMITS: Record<keyof LimitsConfig, true> = { body: true, byPath: true }
const SERVE: Record<keyof ServeConfig, true> = { apiPath: true, compress: true, compressionDictionary: true, shutdownTimeout: true }
const OBSERVE: Record<keyof ObserveConfig, true> = { log: true, serverTiming: true, requestIdHeader: true, tracer: true, onError: true }
const CLIENT: Record<keyof ClientConfig, true> = { navigation: true, inlineStyles: true, lateStyles: true, typography: true, hydration: true, prefetch: true, saveData: true }
const OFFLINE: Record<keyof OfflineConfig, true> = { pages: true, fallback: true }
const HEALTH: Record<keyof HealthConfig, true> = { path: true, timeout: true, check: true }
const PROXY: Record<keyof ProxyConfig, true> = { hops: true, header: true, trusted: true, trustPrivate: true, key: true, open: true }
const SITEMAP: Record<keyof SitemapConfig, true> = { ttl: true }

// The keys 1.84 renamed so that every directory ends in `Dir` and no two keys differ by a letter, each with the key that replaces it: still read until 1.87, and reported by `deprecated-config-keys`.
export const RENAMED_KEYS = { routes: 'routesDir', api: 'apiDir', content: 'contentConfig', storage: 'fileStore', maxSizes: 'maxSizeByPath', settings: 'librarySettings' } as const satisfies Partial<Record<keyof KayConfig, keyof KayConfig>>

// The config with each key of `RENAMED_KEYS` under its new name, unless the new name is set already, in which case it wins.
export function renamedKeys<Config extends object>(config: Config): Config {
  const given = config as Record<string, unknown>

  if (!Object.keys(RENAMED_KEYS).some(old => Object.hasOwn(given, old)))
    return config

  const renamed: Record<string, unknown> = { ...given }

  for (const [old, name] of Object.entries(RENAMED_KEYS)) {
    if (!Object.hasOwn(given, old))
      continue

    delete renamed[old]
    renamed[name] ??= given[old]
  }

  return renamed as Config
}

// The flat keys 1.88 grouped by concern, each with the bag that holds it now and its name there: still read until 1.91, and reported by `deprecated-config-groups`.
export const GROUPED_KEYS = {
  routesDir: ['dirs', 'routes'],
  apiDir: ['dirs', 'api'],
  publicDir: ['dirs', 'public'],
  maxSize: ['limits', 'body'],
  maxSizeByPath: ['limits', 'byPath'],
  apiPath: ['serve', 'apiPath'],
  compress: ['serve', 'compress'],
  compressionDictionary: ['serve', 'compressionDictionary'],
  shutdownTimeout: ['serve', 'shutdownTimeout'],
  log: ['observe', 'log'],
  serverTiming: ['observe', 'serverTiming'],
  requestIdHeader: ['observe', 'requestIdHeader'],
  tracer: ['observe', 'tracer'],
  onError: ['observe', 'onError'],
  navigation: ['client', 'navigation'],
  inlineStyles: ['client', 'inlineStyles'],
  lateStyles: ['client', 'lateStyles'],
  typography: ['client', 'typography'],
  hydration: ['client', 'hydration'],
  prefetch: ['client', 'prefetch'],
  saveData: ['client', 'saveData'],
} as const satisfies Partial<Record<keyof KayConfig, readonly [keyof KayConfig, string]>>

export const CONFIG_GROUPS = ['dirs', 'limits', 'serve', 'observe', 'client'] as const

export const isBag = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// The config with each key of `GROUPED_KEYS` written in its bag, unless the bag sets it already, in which case the bag wins.
export function groupedKeys<Config extends object>(config: Config): Config {
  const given = config as Record<string, unknown>

  if (!Object.keys(GROUPED_KEYS).some(old => Object.hasOwn(given, old)))
    return config

  const grouped: Record<string, unknown> = { ...given }

  for (const [old, [group, name]] of Object.entries(GROUPED_KEYS)) {
    if (!Object.hasOwn(given, old))
      continue

    delete grouped[old]

    const bag = grouped[group]

    if (bag !== undefined && !isBag(bag))
      continue

    const next = { ...bag }

    next[name] ??= given[old]
    grouped[group] = next
  }

  return grouped as Config
}

// The config as the current release reads it: the 1.84 names renamed, then every flat key in its bag.
export function currentKeys<Config extends object>(config: Config): Config {
  return groupedKeys(renamedKeys(config))
}

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

const BAGS: Record<string, Record<string, true>> = { dirs: DIRS, limits: LIMITS, serve: SERVE, observe: OBSERVE, client: CLIENT, security: SECURITY, i18n: I18N, seo: SEO, offline: OFFLINE, health: HEALTH, proxy: PROXY, sitemap: SITEMAP }

// Each key of a config, or of one of its option bags, that no type of the config takes, as `` `trailingslash`, did you mean `trailingSlash`? ``; what an app mistyped would otherwise leave at kay's default with nothing said.
// A bag that is not an object is left to the checks of its own value.
export function unknownConfigKeys(config: object): string[] {
  const problems: string[] = []

  const report = (given: object, known: Record<string, true>, path: string): void => {
    for (const key of Object.keys(given)) {
      if (Object.hasOwn(known, key))
        continue

      // An old name is offered as the name that replaced it.
      const found = nearest(key, Object.keys(known))
      const renamed = found !== undefined && known === CONFIG && Object.hasOwn(RENAMED_KEYS, found) ? RENAMED_KEYS[found as keyof typeof RENAMED_KEYS] : found
      // A key that moved into a bag is offered where it lives now.
      const grouped = renamed !== undefined && known === CONFIG && Object.hasOwn(GROUPED_KEYS, renamed) ? GROUPED_KEYS[renamed as keyof typeof GROUPED_KEYS] : undefined
      const near = grouped === undefined ? renamed : `${grouped[0]}.${grouped[1]}`

      problems.push(`\`${path}${key}\`${near === undefined ? '' : `, did you mean \`${path}${near}\`?`}`)
    }
  }

  report(config, CONFIG, '')

  for (const [name, known] of Object.entries(BAGS)) {
    const bag: unknown = (config as Record<string, unknown>)[name]

    if (typeof bag === 'object' && bag !== null && !Array.isArray(bag))
      report(bag, known, `${name}.`)
  }

  return problems
}
