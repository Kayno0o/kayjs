import type { Prefetch } from './speculation'
import { generateHydrationScript } from '@solidjs/web'
import { LIVE_RELOAD } from './dev'
import { speculationRules } from './speculation'
import { SWAP_CALL, SWAP_SCRIPT } from './stream'

export interface ScriptHashOptions {
  prefetch?: Prefetch
  // Adds the live-reload script `kay dev` pages carry.
  dev?: boolean
}

const SCRIPT_BODY = /<script[^>]*>([\s\S]*?)<\/script>/g

// The `'sha256-...'` sources a `script-src` needs for every inline script kay writes: the hydration bootstrap, the speculation rules and the streamed-block swap.
// Each is the same on every page, so a strict policy allows them without `'unsafe-inline'` or a nonce.
export function inlineScriptHashes(options: ScriptHashOptions = {}): string[] {
  const html = generateHydrationScript() + speculationRules(options.prefetch) + (options.dev ? LIVE_RELOAD : '')
  const scripts = [...[...html.matchAll(SCRIPT_BODY)].map(match => match[1]!), SWAP_SCRIPT, SWAP_CALL]

  return scripts.map(script => `'sha256-${new Bun.CryptoHasher('sha256').update(script).digest('base64')}'`)
}
