import type { HealthConfig, I18nConfig, KayConfig, OfflineConfig, ProxyConfig, SecurityConfig, SeoConfig } from './config'
import { nearest } from './nearest'

// Every key the config and its nested bags take, written as records so the compiler refuses a key added to a type and missing here, or listed here and gone from the type.
const CONFIG: Record<keyof KayConfig, true> = { routes: true, api: true, maxSizes: true, content: true, settings: true, storage: true, i18n: true, routesDir: true, apiDir: true, apiPath: true, publicDir: true, publicCache: true, minify: true, lang: true, site: true, seo: true, robots: true, head: true, images: true, budget: true, favicon: true, manifest: true, entry: true, offline: true, search: true, fonts: true, security: true, proxy: true, maxSize: true, maxSizeByPath: true, requireGuards: true, cors: true, openapi: true, mcp: true, compress: true, compressionDictionary: true, health: true, metrics: true, jobs: true, log: true, serverTiming: true, tracer: true, rewrite: true, redirects: true, runtimeRedirects: true, live: true, requestIdHeader: true, timeZone: true, base: true, links: true, trailingSlash: true, contentConfig: true, markdown: true, shutdownTimeout: true, navigation: true, inlineStyles: true, lateStyles: true, typography: true, hydration: true, prefetch: true, saveData: true, plugins: true, librarySettings: true, lints: true, secret: true, preview: true, fileStore: true, store: true, onError: true, env: true, checks: true, extensions: true }
const SECURITY: Record<keyof SecurityConfig, true> = { csp: true, reportOnly: true, reports: true, permissions: true, headers: true, hosts: true }
const I18N: Record<keyof I18nConfig, true> = { locales: true, defaultLocale: true, prefixDefault: true, domains: true, paths: true, messages: true }
const SEO: Record<keyof SeoConfig, true> = { name: true, titleTemplate: true, description: true, image: true, imageAlt: true, twitter: true, locale: true, themeColor: true, jsonLd: true }
const OFFLINE: Record<keyof OfflineConfig, true> = { pages: true, fallback: true }
const HEALTH: Record<keyof HealthConfig, true> = { path: true, timeout: true, check: true }
const PROXY: Record<keyof ProxyConfig, true> = { hops: true, header: true, trusted: true, trustPrivate: true, key: true, open: true }

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

const BAGS: Record<string, Record<string, true>> = { security: SECURITY, i18n: I18N, seo: SEO, offline: OFFLINE, health: HEALTH, proxy: PROXY }

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
      const near = found !== undefined && known === CONFIG && Object.hasOwn(RENAMED_KEYS, found) ? RENAMED_KEYS[found as keyof typeof RENAMED_KEYS] : found

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
