import type { BunPlugin } from 'bun'
import type { Prefetch } from './server/speculation'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// What `kay.config.ts` exports by default; `pages()`, `kay build`, `kay dev` and `kay check` all read it.
export interface KayConfig {
  // Page directory, relative to the root. Defaults to `src/routes`.
  routes?: string
  // Files served as they are at their path, relative to the root. Defaults to `public`.
  publicDir?: string
  minify?: boolean
  lang?: string
  // When the browser fetches a page a link points at before it is followed: `moderate`, the default, on hover. A link with `data-no-prefetch` never is.
  prefetch?: Prefetch
  // Bun plugins the browser build runs, such as Tailwind's.
  plugins?: BunPlugin[]
  // Receives every error a load, a render, a guard or an action throws, as it is logged: the place to send them to an error tracker.
  onError?: (error: unknown, request: Request) => void | Promise<void>
}

export const CONFIG_FILE = 'kay.config.ts'

export function defineConfig(config: KayConfig): KayConfig {
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
