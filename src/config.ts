import type { BunPlugin } from 'bun'
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
  // Bun plugins the browser build runs, such as Tailwind's.
  plugins?: BunPlugin[]
}

export const CONFIG_FILE = 'kay.config.ts'

export function defineConfig(config: KayConfig): KayConfig {
  return config
}

export async function loadConfig(root: string): Promise<KayConfig> {
  const file = join(root, CONFIG_FILE)

  return existsSync(file) ? (await import(file) as { default: KayConfig }).default : {}
}
