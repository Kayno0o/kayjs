// Config helpers: `defineConfig`, `definePlugin`, and the merge of `kay.config.ts` runtime keys with caller overrides.

import type { KayConfig, KayPlugin, ServerRuntimeConfig } from './types'

export function defineConfig(config: KayConfig): KayConfig {
  return config
}

/** Forwards every runtime key from `kay.config.ts`, stripping build/CLI-only keys (`routesDir`, `outDir`, `publicDir`, `port`). */
export function pickRuntimeConfig(config: KayConfig | undefined): ServerRuntimeConfig {
  if (config === undefined)
    return {}
  const { routesDir: _r, outDir: _o, publicDir: _p, port: _pt, ...runtime } = config
  return runtime
}

const RUNTIME_CONFIG_KEYS: readonly (keyof ServerRuntimeConfig)[] = [
  'site',
  'lang',
  'assetPrefix',
  'security',
  'trustedOrigins',
  'trustProxy',
  'maxRequestBodySize',
  'navigation',
  'streamTimeout',
  'compress',
  'onError',
  'plugins',
]

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
