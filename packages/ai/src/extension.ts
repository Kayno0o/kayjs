import type { KayExtension } from 'kay/server'
import { aiEnv } from './config'

// Lists the variables `ask` reads in `kay.config.ts`'s `extensions`, so `kay env` shows them without the app wiring them; `ask` works without it.
export function ai(): KayExtension {
  return { name: '@kaynooo/kayjs-ai', env: aiEnv(true) }
}
