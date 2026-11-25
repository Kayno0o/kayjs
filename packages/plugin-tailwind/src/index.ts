// @kayjs/tailwind — opt-in CSS & Tailwind v4 plugin using KayPlugin.bunPlugins + KayPlugin.css.
// Auto-loads `bun-plugin-tailwind` from the app root when `bunPlugin` is omitted.

import type { BunPlugin } from 'bun'
import type { KayPlugin } from '@kayjs/kay/server'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export interface TailwindPluginOptions {
  /** Global stylesheet entry path relative to project root (default: 'src/app.css'). */
  css?: string | undefined
  /** Optional Bun CSS/Tailwind plugin override; auto-resolved from `bun-plugin-tailwind` when omitted. */
  bunPlugin?: BunPlugin | undefined
}

function loadDefaultTailwindPlugin(root: string): BunPlugin | undefined {
  for (const base of [join(root, 'package.json'), import.meta.url]) {
    try {
      const req = createRequire(base)
      const mod = req('bun-plugin-tailwind') as BunPlugin | { default?: BunPlugin }
      const plugin = typeof (mod as { default?: BunPlugin }).default === 'object'
        ? (mod as { default: BunPlugin }).default
        : mod as BunPlugin
      if (plugin !== undefined && typeof plugin.setup === 'function')
        return plugin
    }
    catch {}
  }
  return undefined
}

export function tailwind(options: TailwindPluginOptions = {}): KayPlugin {
  return {
    name: '@kayjs/tailwind',
    css: [options.css ?? 'src/app.css'],
    bunPlugins: options.bunPlugin !== undefined
      ? [options.bunPlugin]
      : ({ root }) => {
          const auto = loadDefaultTailwindPlugin(root)
          return auto !== undefined ? [auto] : []
        },
  }
}
