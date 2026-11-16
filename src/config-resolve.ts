import type { ConfigInput, EndpointsConfig, I18nConfig, I18nInput, ImageFormats, ImageLimits, KayConfig, Loadable, ObserveConfig, ObserveInput, RemoteImages } from './config'
import type { McpConfig } from './server/api-modules'
import type { OpenApiConfig } from './server/openapi'
import { KayError } from './compiler/errors'
import { isRecord } from './config-rules'

// A list as the config gave it: itself, or what the function returns, awaited.
async function load<Value>(value: Loadable<Value>): Promise<Value> {
  return typeof value === 'function' ? (value as () => Value | Promise<Value>)() : value
}

// Each key of a bag that holds a loadable list, loaded; a bag the config gave as `true` or `false` is left alone.
async function loadKeys<Bag extends object>(bag: Bag | boolean | number | undefined, keys: readonly string[]): Promise<Bag | boolean | number | undefined> {
  if (!isRecord(bag))
    return bag

  const loaded: Record<string, unknown> = { ...bag }

  await Promise.all(keys.map(async (key) => {
    if (loaded[key] !== undefined)
      loaded[key] = await load(loaded[key] as Loadable<unknown>)
  }))

  return loaded as Bag
}

// The top-level keys of before 1.105 that live in a group of the loaded config now.
const MOVED_KEYS = ['offline', 'search', 'links', 'images', 'fonts', 'favicon', 'manifest', 'publicCache', 'observe', 'health', 'metrics', 'jobs'] as const

const without = <Value extends object>(value: Value): Value => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Value

// `images` with its remote hosts loaded and the flat keys of before 1.105 moved into their groups, a key already in its group winning over the old one.
async function resolveImages(images: NonNullable<ConfigInput['images']>): Promise<NonNullable<NonNullable<KayConfig['assets']>['images']>> {
  const { remote, remoteMaxSize, remoteTimeout, maxVariants, queue, quality, webp, avif, ...rest } = images
  const given: Omit<RemoteImages, 'hosts'> & { hosts?: Loadable<string[]> | undefined } = typeof remote === 'function' || Array.isArray(remote) ? { hosts: remote } : remote ?? {}
  const hosts = given.hosts === undefined ? undefined : await load(given.hosts)
  const grouped = without({ hosts, maxSize: given.maxSize ?? remoteMaxSize, timeout: given.timeout ?? remoteTimeout })
  const formats: ImageFormats = without({ quality: rest.formats?.quality ?? quality, webp: rest.formats?.webp ?? webp, avif: rest.formats?.avif ?? avif })
  const limits: ImageLimits = without({ variants: rest.limits?.variants ?? maxVariants, queue: rest.limits?.queue ?? queue })

  return {
    ...rest,
    ...Object.keys(grouped).length > 0 && { remote: grouped },
    ...Object.keys(formats).length > 0 && { formats: { ...rest.formats, ...formats } },
    ...Object.keys(limits).length > 0 && { limits: { ...rest.limits, ...limits } },
  }
}

// `observe` with its `log` as the group it is since 1.105 (`'json'` is `{ format: 'json' }`, a function `{ sink }`), and the `onError` it held, which is a key of the config now, set aside.
function resolveObserve(observe: ObserveInput): { observe: ObserveConfig, onError: ObserveInput['onError'] } {
  const { log, onError, ...rest } = observe
  const named = log === 'json' ? { format: 'json' as const } : log
  const grouped = typeof named === 'function' ? { sink: named } : named

  return { observe: { ...rest, ...grouped !== undefined && { log: grouped } }, onError }
}

// `client` with the `links`, `offline` and `search` the config held at its top level before 1.105, a key already in `client` winning over the old one.
function resolveClient(config: ConfigInput): KayConfig['client'] {
  const { offline, search, links } = config
  const moved = without({ offline, search, links })

  return config.client === undefined && Object.keys(moved).length === 0 ? undefined : { ...moved, ...without(config.client ?? {}) }
}

// `assets` with the `images`, `fonts`, `favicon`, `manifest` and `publicCache` the config held at its top level before 1.105, a key already in `assets` winning over the old one, and the images resolved.
async function resolveAssets(config: ConfigInput): Promise<KayConfig['assets']> {
  const { images, fonts, favicon, manifest, publicCache } = config
  const moved = without({ images, fonts, favicon, manifest, publicCache })
  const given = without(config.assets ?? {})
  const merged = { ...moved, ...given }

  if (Object.keys(merged).length === 0)
    return config.assets === undefined ? undefined : {}

  const { images: unresolved, ...rest } = merged

  return { ...rest, ...unresolved !== undefined && { images: await resolveImages(unresolved) } }
}

// `ops` with the `observe`, `health`, `metrics` and `jobs` the config held at its top level before 1.105, a key already in `ops` winning over the old one, and the `onError` an `observe` held set aside.
function resolveOps(config: ConfigInput): { ops: KayConfig['ops'], onError: ObserveInput['onError'], paths: EndpointsConfig } {
  const merged = { ...without({ observe: config.observe, health: config.health, metrics: config.metrics, jobs: config.jobs }), ...without(config.ops ?? {}) }

  if (Object.keys(merged).length === 0)
    return { ops: config.ops === undefined ? undefined : {}, onError: undefined, paths: {} }

  const { observe: given, health, metrics, jobs, ...rest } = merged
  const resolved = given === undefined ? undefined : resolveObserve(given)
  const [kept, paths] = [takePath(health), takePath(metrics), takePath(jobs)].reduce<[Record<string, unknown>, EndpointsConfig]>(([bags, at], [bag, path], index) => {
    const name = (['health', 'metrics', 'jobs'] as const)[index]!

    return [{ ...bags, ...bag !== undefined && { [name]: bag } }, { ...at, ...path !== undefined && { [name]: path } }]
  }, [{}, {}])

  return { ops: { ...rest, ...kept, ...resolved && { observe: resolved.observe } }, onError: resolved?.onError, paths }
}

// A bag without the `path` it held before 1.105, which is a key of `endpoints` since, and that path.
function takePath<Bag>(bag: Bag): [Bag, string | undefined] {
  if (!isRecord(bag) || !('path' in bag))
    return [bag, undefined]

  const { path, ...rest } = bag

  // Whatever it is, so the boot refuses one that is no path.
  return [rest as Bag, path as string | undefined]
}

// `endpoints` with the paths the bags held before 1.105 (`serve.apiPrefix`, the `path` of `openapi`, `mcp`, `health`, `metrics` and `jobs`, the `referencePath` of `openapi`), a key already in `endpoints` winning over the old one, and the bags without them.
function resolveEndpoints(config: ConfigInput, opsPaths: EndpointsConfig, mcp: ConfigInput['mcp']): { endpoints: KayConfig['endpoints'], serve: KayConfig['serve'], openapi: KayConfig['openapi'], mcp: KayConfig['mcp'] } {
  const { apiPrefix, ...serve } = config.serve ?? {}
  const [bareMcp, mcpAt] = takePath(mcp)
  const { path: openapiAt, referencePath, ...openapi } = isRecord(config.openapi) ? config.openapi : {} as Record<string, never>
  const written = isRecord(config.openapi)
  const reference = referencePath !== undefined && openapi.reference === true ? { path: referencePath } : openapi.reference
  const moved: EndpointsConfig = without({ api: apiPrefix, openapi: openapiAt as string | undefined, mcp: mcpAt, ...opsPaths })
  const merged = { ...moved, ...without(config.endpoints ?? {}) }

  return {
    endpoints: Object.keys(merged).length === 0 ? config.endpoints : merged,
    serve: config.serve === undefined ? undefined : serve,
    openapi: written ? { ...openapi, ...reference !== undefined && { reference } } as OpenApiConfig : config.openapi,
    mcp: bareMcp,
  }
}

// `i18n` with its paths loaded and the `defaultLocale`, `prefixDefault` and `domains` of before 1.105 as `default` and `mode`, a key already in its new place winning over the old one.
async function resolveI18n(i18n: I18nInput | undefined): Promise<I18nConfig | undefined> {
  const loaded = await loadKeys(i18n, ['paths'])

  if (!isRecord(loaded))
    return loaded as undefined

  const { defaultLocale, prefixDefault, domains, default: named, mode, ...rest } = loaded as Omit<I18nInput, 'paths'> & { paths?: I18nConfig['paths'] }

  if (mode === undefined && domains !== undefined && prefixDefault === true)
    throw new KayError('locales-invalid', 'kay: i18n gives domains or prefixDefault, not both: with domains a locale has no prefix')

  const chosen = mode ?? (domains === undefined ? prefixed(prefixDefault) : { domains })
  const first = named ?? defaultLocale

  return { ...rest, default: first as string, ...chosen !== undefined && { mode: chosen } }
}

// `proxy` with the header a string `key` named before 1.105 as `{ header }`.
function resolveProxy(proxy: ConfigInput['proxy']): KayConfig['proxy'] {
  if (!isRecord(proxy) || typeof proxy.key !== 'string')
    return proxy as KayConfig['proxy']

  return { ...proxy, key: { header: proxy.key } } as KayConfig['proxy']
}

// `mcp` with the `key` of before 1.105 as `token`, a `token` already written winning over it.
function resolveMcp(mcp: ConfigInput['mcp']): KayConfig['mcp'] {
  if (!isRecord(mcp) || !('key' in mcp))
    return mcp

  const { key, ...rest } = mcp

  return key === undefined || key === false || rest.token !== undefined ? rest : { ...rest, token: key as McpConfig['token'] }
}

// The config `kay.config.ts` wrote as the `KayConfig` the server reads: each list that a function gave loaded once, the old flat keys of `images`, the `onStart` hook and `observe`'s `onError` and `log` in the places they have since 1.105. Called as the config loads, so `kay dev` calls the functions again after a change to the file.
export async function resolveConfig(config: ConfigInput): Promise<KayConfig> {
  const [security, proxy, robots, i18n, redirects, assets] = await Promise.all([
    loadKeys(config.security, ['hosts']),
    loadKeys(config.proxy, ['trusted']),
    loadKeys(config.robots, ['disallow', 'allow']),
    resolveI18n(config.i18n),
    config.redirects === undefined ? undefined : load(config.redirects),
    resolveAssets(config),
  ])
  const cors = config.cors === undefined ? undefined : await loadKeys(config.cors, ['origins'])
  const { onStart, ...kept } = config

  for (const key of MOVED_KEYS)
    delete kept[key]

  const { ops, onError, paths } = resolveOps(config)
  const routes = resolveEndpoints(config, paths, resolveMcp(config.mcp))
  const resolved: Record<string, unknown> = { ...kept, security, proxy: resolveProxy(proxy), ...routes, robots, i18n, redirects, assets, ops, cors, client: resolveClient(config), onListen: config.onListen ?? onStart, onError: config.onError ?? onError }

  for (const key of Object.keys(resolved)) {
    if (resolved[key] === undefined)
      delete resolved[key]
  }

  return resolved
}

function prefixed(prefixDefault: boolean | undefined): 'always' | undefined {
  return prefixDefault === true ? 'always' : undefined
}
