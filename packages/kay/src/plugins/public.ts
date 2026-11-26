// `@kayjs/kay/config`: what `kay.config.ts` and plugin packages use.

export { defineConfig, definePlugin } from './config'
export { CONTENT_IMAGE_RESOLVER_SERVICE, I18N_CONFIG_SERVICE } from './services'
export type { ActiveI18nConfig, ContentImageResolver, ContentImageResult } from './services'
export type { BuildPluginContext, BuildPluginTarget, CheckPluginContext, DocumentHeadContext, FinalizeBuildContext, KayConfig, KayPlugin, MiddlewareOptions, PluginRouteOptions, ServerErrorInfo, ServerPluginAPI, ServerRuntimeConfig } from './types'
