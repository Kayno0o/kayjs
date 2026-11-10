import type { KayExtension } from 'kay/server'
import type { AiOptions } from './limits'
import { checkOptionKeys, underKayDev } from 'kay/library'
import { api } from 'kay/server'
import { aiEnv, choose } from './config'
import { useConversations } from './conversation-home'
import { recordedAsks } from './dev-log'
import { configureHooks } from './hooks'
import { draftProblems, noModelProblems, startDrafting, writeImageAlts, writeKeptImageAlts } from './image-alt'
import { configureLimits, limitsInEffect } from './limits'
import { configureModels, defaultNamed } from './models'
import { configureResilience } from './retry'

// The provider and model an ask would use now, or why none can be chosen.
function providerNow(): { provider: string, model: string | null } | { error: string } {
  try {
    const set = defaultNamed()
    const { provider, model } = set?.provider === undefined ? choose() : { provider: set.provider, model: undefined }

    return { provider: provider.name, model: set?.model ?? model ?? provider.model ?? null }
  }
  catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

const KNOWN_OPTIONS: Record<keyof AiOptions, true> = { rateLimit: true, budget: true, key: true, conversations: true, imageAlt: true, models: true, default: true, beforeRequest: true, onStep: true, onToolCall: true, onSuccess: true, onError: true, retry: true, fallback: true }

// Lists the variables `ask` reads in `kay.config.ts`'s `extensions`, so `kay env` shows them without the app wiring them, holds the limit and budget every `ask` counts against, adds `kay i18n translate` and the dev tool's AI tab, and with `imageAlt` drafts the `alt` of the imported images a page shows with none; `ask` works without it, unlimited in development and under the production defaults otherwise.
export function ai(options: AiOptions = {}): KayExtension {
  checkOptionKeys('ai()', options, KNOWN_OPTIONS)

  configureLimits(options)
  configureHooks(options)
  configureResilience(options)
  configureModels(options)

  const imageAlt = options.imageAlt === true || typeof options.imageAlt === 'object'

  if (imageAlt)
    startDrafting()

  useConversations(options.conversations)

  return {
    name: '@kaynooo/kayjs-ai',
    env: aiEnv(true),
    commands: { 'i18n translate': `${import.meta.dir}/translate.ts` },
    devTool: { module: `${import.meta.dir}/devTool.ts` },
    ...imageAlt && {
      satisfies: ['missing-alt' as const],
      transformPage: writeImageAlts,
      transformServedPage: writeKeptImageAlts,
      check: async () => [...noModelProblems(), ...await draftProblems(typeof options.imageAlt === 'object' ? options.imageAlt.reviewed : undefined)],
    },
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
