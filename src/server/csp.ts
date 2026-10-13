import type { Prefetch } from './speculation'
import { DEV_BOOT, LIVE_RELOAD } from './dev'
import { historyScript } from './history'
import { hydrationScript } from './hydration'
import { registerScript } from './offline'
import { speculationRules } from './speculation'
import { SWAP_CALL, SWAP_SCRIPT } from './stream'

export interface ScriptHashOptions {
  prefetch?: Prefetch | undefined
  // Adds the live-reload script `kay dev` pages carry.
  dev?: boolean | undefined
  // The site's mount point, which the speculation rules and the service worker's registration name.
  base?: string | undefined
  // Adds the script registering the service worker `offline` turns on.
  offline?: boolean | undefined
}

const SCRIPT_BODY = /<script[^>]*>([\s\S]*?)<\/script>/g

// The `'sha256-...'` sources a `script-src` needs for every inline script kay writes: the hydration bootstrap, the history script of a page without one of kay's, the speculation rules, the streamed-block swap and the service worker's registration.
// Each is the same on every page, so a strict policy allows them without `'unsafe-inline'` or a nonce.
export function inlineScriptHashes(options: ScriptHashOptions = {}): string[] {
  const html = hydrationScript + historyScript + speculationRules(options.prefetch, options.base) + (options.dev ? LIVE_RELOAD + DEV_BOOT : '') + (options.offline ? registerScript(options.base ?? '') : '')
  const scripts = [...[...html.matchAll(SCRIPT_BODY)].map(match => match[1]!), SWAP_SCRIPT, SWAP_CALL]

  return scripts.map(sourceHash)
}

// The `'sha256-...'` source allowing one inline script or style.
export function sourceHash(text: string): string {
  return `'sha256-${new Bun.CryptoHasher('sha256').update(text).digest('base64')}'`
}
