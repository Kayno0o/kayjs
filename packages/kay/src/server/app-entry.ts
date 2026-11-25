// What the generated `dist/server/_entry.js` calls: an app from its bundled config and modules, plus what the caller serves it with.

import type { KayConfig } from '../plugins/index'
import type { EmbeddedServerConfig, KayApp } from './http'
import { resolveServerConfig } from '../plugins/index'
import { createServerFromEmbedded } from './index'

/** The manifest, assets and paths the caller read or embedded; runtime keys set here win over `kay.config.ts`. */
export type AppEntryOptions = Omit<EmbeddedServerConfig, 'modules'>

/** The exports of `dist/server/_entry.js`. */
export interface ServerEntry {
  kayConfig: KayConfig
  /** Bundled modules by manifest key. */
  modules: Record<string, Record<string, unknown>>
  /** The same modules by root-relative source path. */
  sources: Record<string, Record<string, unknown>>
  createApp: (options: AppEntryOptions) => Promise<KayApp>
}

export function createAppFromEntry(config: KayConfig, modules: Record<string, unknown>, options: AppEntryOptions): Promise<KayApp> {
  return createServerFromEmbedded({ ...options, ...resolveServerConfig(config, options), modules })
}
