// Config helpers: `defineConfig`, `definePlugin`, the known `kay.config.ts` keys, and the merge of its runtime keys with caller overrides.

import type { KayConfig, KayPlugin, ServerRuntimeConfig } from './types'

export function defineConfig(config: KayConfig): KayConfig {
  return config
}

/** Forwards every runtime key from `kay.config.ts`, stripping build/CLI-only keys (`routesDir`, `outDir`, `publicDir`, `port`, `compliance`). */
export function pickRuntimeConfig(config: KayConfig | undefined): ServerRuntimeConfig {
  if (config === undefined)
    return {}
  const { routesDir: _r, outDir: _o, publicDir: _p, port: _pt, compliance: _c, ...runtime } = config
  return runtime
}

// Typed as records so that a key added to the config types without being listed here fails the typecheck.
const RUNTIME_KEYS: Record<keyof ServerRuntimeConfig, true> = { site: true, lang: true, assetPrefix: true, security: true, trustedOrigins: true, trustProxy: true, maxRequestBodySize: true, navigation: true, streamTimeout: true, consent: true, compress: true, onError: true, plugins: true }
const BUILD_KEYS: Record<Exclude<keyof KayConfig, keyof ServerRuntimeConfig>, true> = { port: true, routesDir: true, outDir: true, publicDir: true, compliance: true }
const RUNTIME_CONFIG_KEYS = Object.keys(RUNTIME_KEYS) as (keyof ServerRuntimeConfig)[]
const CONFIG_KEYS = [...RUNTIME_CONFIG_KEYS, ...Object.keys(BUILD_KEYS)]

// Edit distance, two neighbours swapped counting as one edit.
function editDistance(a: string, b: string): number {
  let before: number[] = []
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1]
    for (let j = 0; j < b.length; j++) {
      let cost = Math.min(previous[j + 1]! + 1, current[j]! + 1, previous[j]! + (a[i] === b[j] ? 0 : 1))
      if (i > 0 && j > 0 && a[i] === b[j - 1] && a[i - 1] === b[j])
        cost = Math.min(cost, before[j - 1]! + 1)
      current.push(cost)
    }
    before = previous
    previous = current
  }
  return previous[b.length]!
}

/** The name of `names` within two edits of `name` (one for a name under four letters), the nearest first: the one a typo meant. */
export function closestName(name: string, names: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDistance = name.length < 4 ? 2 : 3
  for (const known of names) {
    const far = editDistance(name, known)
    if (far < bestDistance) {
      best = known
      bestDistance = far
    }
  }
  return best
}

/** Throws on a key `kay.config.ts` sets that kay does not read, naming the key it most likely meant. */
export function assertKnownConfigKeys(config: object): void {
  const problems: string[] = []
  for (const key of Object.keys(config)) {
    if (CONFIG_KEYS.includes(key))
      continue
    const near = closestName(key, CONFIG_KEYS)
    problems.push(near === undefined ? `"${key}" is not a kay.config.ts key: remove it (the keys are ${CONFIG_KEYS.join(', ')})` : `"${key}" is not a kay.config.ts key: did you mean "${near}"?`)
  }
  if (problems.length > 0)
    throw new Error(`kay: ${problems.join('\nkay: ')}`)
}

/** Merges runtime options from `kay.config.ts` with explicit caller overrides (ignoring `undefined` override fields). */
export function resolveServerConfig(
  fileConfig: KayConfig | undefined,
  overrides?: Partial<ServerRuntimeConfig> | undefined,
): ServerRuntimeConfig {
  const merged: Record<string, unknown> = { ...pickRuntimeConfig(fileConfig) }
  if (overrides !== undefined) {
    for (const key of RUNTIME_CONFIG_KEYS) {
      const value = overrides[key]
      if (value !== undefined)
        merged[key] = value
    }
  }
  return merged as ServerRuntimeConfig
}

export function definePlugin(plugin: KayPlugin): KayPlugin {
  return plugin
}
