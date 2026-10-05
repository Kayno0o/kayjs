import type { Prefetch } from './speculation'
import { DEV_PROBLEMS, LIVE_RELOAD } from './dev'
import { hydrationScript } from './hydration'
import { speculationRules } from './speculation'
import { SWAP_CALL, SWAP_SCRIPT } from './stream'

export interface ScriptHashOptions {
  prefetch?: Prefetch
  // Adds the live-reload script `kay dev` pages carry.
  dev?: boolean
  // The site's mount point, which the speculation rules name.
  base?: string
}

const SCRIPT_BODY = /<script[^>]*>([\s\S]*?)<\/script>/g

// The `'sha256-...'` sources a `script-src` needs for every inline script kay writes: the hydration bootstrap, the speculation rules and the streamed-block swap.
// Each is the same on every page, so a strict policy allows them without `'unsafe-inline'` or a nonce.
export function inlineScriptHashes(options: ScriptHashOptions = {}): string[] {
  const html = hydrationScript + speculationRules(options.prefetch, options.base) + (options.dev ? LIVE_RELOAD + DEV_PROBLEMS : '')
  const scripts = [...[...html.matchAll(SCRIPT_BODY)].map(match => match[1]!), SWAP_SCRIPT, SWAP_CALL]

  return scripts.map(script => `'sha256-${new Bun.CryptoHasher('sha256').update(script).digest('base64')}'`)
}
