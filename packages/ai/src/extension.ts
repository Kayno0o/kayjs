import type { KayExtension } from 'kay/server'
import type { AiOptions } from './limits'
import { aiEnv } from './config'
import { configureLimits } from './limits'

// Lists the variables `ask` reads in `kay.config.ts`'s `extensions`, so `kay env` shows them without the app wiring them, and holds the limit and budget every `ask` counts against; `ask` works without it, unlimited.
export function ai(options: AiOptions = {}): KayExtension {
  configureLimits(options)

  return { name: '@kaynooo/kayjs-ai', env: aiEnv(true) }
}
