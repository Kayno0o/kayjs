import type { BunPlugin } from 'bun'
import type { KayPluginOptions } from './plugin'
import { kay as kayPlugin } from './plugin'

export interface KayBunOptions {
  // `.kay` files and assets resolve from here, and imported assets are written under its `.kay/client`; defaults to the working directory.
  root?: string | undefined
  // The app's own module for a library's settings, by the library's name, relative to the root, as `kay.config.ts`'s `settings`.
  settings?: Record<string, string> | undefined
}

// The plugin compiling `.kay` files for a page kay does not serve: for the browser in a browser build, for the server everywhere else. Its components render fresh, with no server markup to hydrate.
export function kay(options: KayBunOptions = {}): BunPlugin {
  return kayPlugin({ ...options, hydratable: false } satisfies KayPluginOptions)
}

// What bunfig's `[serve.static] plugins` loads: a module's default export.
export default kay()
