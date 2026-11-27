// `@kayjs/kay/config`: what `kay.config.ts` and plugin packages use.

export { isInside } from '../build/is-inside'
export { distLocator, firstLoadUrls, measureFirstLoad } from '../build/first-load'
export type { FirstLoad, Locate } from '../build/first-load'
export { brotliSize } from '../build/precompress'
export { defineConfig, definePlugin } from './config'
export { CONTENT_IMAGE_RESOLVER_SERVICE, I18N_CONFIG_SERVICE, serviceKey } from './services'
export type { ActiveI18nConfig, ContentImageResolver, ContentImageResult, ServiceKey } from './services'
export type { ComplianceConfig, ComplianceRule } from '../compiler/compliance'
export type { ConsentConfig } from '../server/consent'
export type { BuildPluginContext, BuildPluginTarget, CheckPluginContext, DocumentHeadContext, FinalizeBuildContext, KayConfig, KayPlugin, MiddlewareOptions, PluginRouteOptions, RequiresPluginContext, ServerErrorInfo, ServerPluginAPI, ServerRuntimeConfig } from './types'
