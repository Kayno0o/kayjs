// Kay v2 public Plugin API & config helpers.
// Strict architectural rule: every non-core capability (@kayjs/tailwind, @kayjs/spa, @kayjs/i18n, etc.)
// is built strictly through these public hooks - never hardcoded in @kay/core.

export { defineConfig, definePlugin, pickRuntimeConfig, resolveServerConfig } from './config'
export { createAppContext, getAppContext, runWithAppContext } from './context'
export type { AppRuntimeContext, CreateAppContextOptions } from './context'
export { loadConfig } from './load'
export { resolvePlugins } from './order'
export { CONTENT_IMAGE_RESOLVER_SERVICE, I18N_CONFIG_SERVICE, serviceKey } from './services'
export type { ActiveI18nConfig, ContentImageResolver, ContentImageResult, ServiceKey } from './services'
export type { BuildPluginContext, BuildPluginTarget, CheckPluginContext, DocumentHeadContext, FinalizeBuildContext, KayConfig, KayPlugin, MiddlewareOptions, PluginRouteOptions, ServerErrorInfo, ServerPluginAPI, ServerRuntimeConfig } from './types'
