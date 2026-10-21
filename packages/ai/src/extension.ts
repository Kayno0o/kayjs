import type { KayExtension } from 'kay/server'
import type { AiOptions } from './limits'
import { underKayDev } from 'kay/library'
import { api } from 'kay/server'
import { aiEnv, choose } from './config'
import { recordedAsks } from './dev-log'
import { configureLimits, limitsInEffect } from './limits'

// The provider and model an ask would use now, or why none can be chosen.
function providerNow(): { provider: string, model: string | null } | { error: string } {
  try {
    const { provider, model } = choose()

    return { provider: provider.name, model: model ?? provider.model ?? null }
  }
  catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// Lists the variables `ask` reads in `kay.config.ts`'s `extensions`, so `kay env` shows them without the app wiring them, holds the limit and budget every `ask` counts against, adds `kay i18n translate` and the dev tool's AI tab; `ask` works without it, unlimited.
export function ai(options: AiOptions = {}): KayExtension {
  configureLimits(options)

  return {
    name: '@kaynooo/kayjs-ai',
    env: aiEnv(true),
    commands: { 'i18n translate': `${import.meta.dir}/translate.ts` },
    devTool: { module: `${import.meta.dir}/devTool.ts` },
    // What the tab reads, answered under `kay dev` alone.
    server: () => {
      const plugin = api()

      if (underKayDev()) {
        plugin.get('/_kay/ai', ({ set }) => {
          set.headers['cache-control'] = 'no-store'

          return { ...providerNow(), ...limitsInEffect(), asks: recordedAsks().toReversed() }
        })
      }

      return plugin
    },
  }
}
