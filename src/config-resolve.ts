import type { ConfigInput, I18nConfig, I18nInput, ImagesInput, KayConfig, Loadable, RemoteImages } from './config'
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

const without = <Value extends object>(value: Value): Value => Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Value

// `images` with its remote hosts loaded.
async function resolveImages(images: ImagesInput): Promise<NonNullable<NonNullable<KayConfig['assets']>['images']>> {
  const { remote, ...rest } = images
  const given: Omit<RemoteImages, 'hosts'> & { hosts?: Loadable<string[]> | undefined } = typeof remote === 'function' || Array.isArray(remote) ? { hosts: remote } : remote ?? {}
  const hosts = given.hosts === undefined ? undefined : await load(given.hosts)
  const grouped = without({ hosts, maxSize: given.maxSize, timeout: given.timeout })

  return { ...rest, ...Object.keys(grouped).length > 0 && { remote: grouped } }
}

// `assets` with its images resolved.
async function resolveAssets(assets: ConfigInput['assets']): Promise<KayConfig['assets']> {
  if (assets?.images === undefined)
    return assets as KayConfig['assets']

  const { images, ...rest } = assets

  return { ...rest, images: await resolveImages(images) }
}

// `i18n` with its paths loaded.
async function resolveI18n(i18n: I18nInput | undefined): Promise<I18nConfig | undefined> {
  return await loadKeys(i18n, ['paths']) as I18nConfig | undefined
}

// The config `kay.config.ts` wrote as the `KayConfig` the server reads: each list that a function gave loaded once. Called as the config loads, so `kay dev` calls the functions again after a change to the file.
export async function resolveConfig(config: ConfigInput): Promise<KayConfig> {
  const [security, proxy, robots, i18n, redirects, assets] = await Promise.all([
    loadKeys(config.security, ['hosts']),
    loadKeys(config.proxy, ['trusted']),
    loadKeys(config.robots, ['disallow', 'allow']),
    resolveI18n(config.i18n),
    config.redirects === undefined ? undefined : load(config.redirects),
    resolveAssets(config.assets),
  ])
  const cors = config.cors === undefined ? undefined : await loadKeys(config.cors, ['origins'])
  // An extension's config is written as `kay.config.ts` is, so its lists load as the app's do.
  const extensions = config.extensions === undefined ? undefined : await Promise.all(config.extensions.map(async extension => extension.config === undefined ? extension : { ...extension, config: await resolveConfig(extension.config) }))
  const resolved: Record<string, unknown> = { ...config, ...extensions !== undefined && { extensions }, security, proxy, robots, i18n, redirects, assets, cors }

  for (const key of Object.keys(resolved)) {
    if (resolved[key] === undefined)
      delete resolved[key]
  }

  return resolved
}
