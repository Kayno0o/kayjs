import type { ConfigInput, ImageFormats, ImageLimits, KayConfig, Loadable, ObserveConfig, ObserveInput, RemoteImages } from './config'
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

// `images` with its remote hosts loaded and the flat keys of before 1.105 moved into their groups, a key already in its group winning over the old one.
async function resolveImages(images: NonNullable<ConfigInput['images']>): Promise<NonNullable<KayConfig['images']>> {
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

// The config `kay.config.ts` wrote as the `KayConfig` the server reads: each list that a function gave loaded once, the old flat keys of `images`, the `onStart` hook and `observe`'s `onError` and `log` in the places they have since 1.105. Called as the config loads, so `kay dev` calls the functions again after a change to the file.
export async function resolveConfig(config: ConfigInput): Promise<KayConfig> {
  const [security, proxy, robots, i18n, redirects, images] = await Promise.all([
    loadKeys(config.security, ['hosts']),
    loadKeys(config.proxy, ['trusted']),
    loadKeys(config.robots, ['disallow', 'allow']),
    loadKeys(config.i18n, ['paths']),
    config.redirects === undefined ? undefined : load(config.redirects),
    config.images === undefined ? undefined : resolveImages(config.images),
  ])
  const cors = config.cors === undefined ? undefined : await loadKeys(config.cors, ['origins'])
  const { onStart, ...kept } = config
  const observed = config.observe === undefined ? undefined : resolveObserve(config.observe)
  const resolved: Record<string, unknown> = { ...kept, security, proxy, robots, i18n, redirects, images, cors, observe: observed?.observe, onListen: config.onListen ?? onStart, onError: config.onError ?? observed?.onError }

  for (const key of Object.keys(resolved)) {
    if (resolved[key] === undefined)
      delete resolved[key]
  }

  return resolved
}
