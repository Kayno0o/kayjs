// @kayjs/tailwind — opt-in CSS & Tailwind v4 plugin using KayPlugin.bunPlugins + KayPlugin.css.

import type { BunPlugin } from 'bun'
import type { KayPlugin } from 'kay/server'

export interface TailwindPluginOptions {
  /** Global stylesheet entry path relative to project root (default: 'src/app.css'). */
  css?: string | undefined
  /** Optional Bun CSS/Tailwind plugin (e.g. `import tailwind from 'bun-plugin-tailwind'`). */
  bunPlugin?: BunPlugin | undefined
}

export function tailwind(options: TailwindPluginOptions = {}): KayPlugin {
  return {
    name: '@kayjs/tailwind',
    css: [options.css ?? 'src/app.css'],
    bunPlugins: options.bunPlugin !== undefined ? [options.bunPlugin] : undefined,
  }
}
