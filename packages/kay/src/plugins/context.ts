// Per-build / per-server scoped runtime context (AsyncLocalStorage-backed, zero mutable process globals).

import { AsyncLocalStorage } from 'node:async_hooks'

export interface ActiveI18nConfig {
  readonly locales: readonly string[]
  readonly defaultLocale: string
  readonly prefixDefault: boolean
}

export const I18N_CONFIG_SERVICE = 'kay.i18n.config'

export interface ContentImageResult {
  src: string
  srcset?: string | undefined
  avifSrcset?: string | undefined
  sizes?: string | undefined
  width?: number | undefined
  height?: number | undefined
  loading?: 'lazy' | 'eager' | undefined
}

export type ContentImageResolver = (src: string, file: string | undefined) => ContentImageResult | string | undefined

export const CONTENT_IMAGE_RESOLVER_SERVICE = 'kay.content.imageResolver'

export interface AppRuntimeContext {
  readonly root: string
  readonly outDir: string
  readonly publicDir: string
  readonly assetPrefix: string
  readonly site?: string | undefined
  readonly dev: boolean
  provide<T>(key: string, value: T): void
  inject<T>(key: string): T | undefined
  registerPublicFile(relPath: string): void
}

export interface CreateAppContextOptions {
  root: string
  outDir: string
  publicDir: string
  assetPrefix: string
  site?: string | undefined
  dev: boolean
  onRegisterPublicFile?: ((relPath: string) => void) | undefined
}

const APP_STORAGE_KEY = Symbol.for('kay.app.storage')
const appStorage: AsyncLocalStorage<AppRuntimeContext> = (
  (globalThis as Record<symbol, AsyncLocalStorage<AppRuntimeContext> | undefined>)[APP_STORAGE_KEY]
    ??= new AsyncLocalStorage<AppRuntimeContext>()
)

export function createAppContext(options: CreateAppContextOptions): AppRuntimeContext {
  const services = new Map<string, unknown>()
  const site = options.site?.replace(/\/$/, '')
  return {
    root: options.root,
    outDir: options.outDir,
    publicDir: options.publicDir,
    assetPrefix: options.assetPrefix,
    ...(site !== undefined && site !== '' ? { site } : {}),
    dev: options.dev,
    provide<T>(key: string, value: T): void {
      services.set(key, value)
    },
    inject<T>(key: string): T | undefined {
      return services.get(key) as T | undefined
    },
    registerPublicFile(relPath: string): void {
      options.onRegisterPublicFile?.(relPath)
    },
  }
}

export function runWithAppContext<T>(ctx: AppRuntimeContext, fn: () => T): T {
  return appStorage.run(ctx, fn)
}

export function getAppContext(): AppRuntimeContext | undefined {
  return appStorage.getStore()
}
