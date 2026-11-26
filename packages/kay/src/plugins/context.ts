// Per-build / per-server scoped runtime context (AsyncLocalStorage-backed, zero mutable process globals).

import type { ServiceKey } from './services'
import { AsyncLocalStorage } from 'node:async_hooks'

export interface AppRuntimeContext {
  readonly root: string
  readonly outDir: string
  readonly publicDir: string
  readonly assetPrefix: string
  readonly site?: string | undefined
  readonly dev: boolean
  readonly nodeEnv?: string | undefined
  provide<T>(key: ServiceKey<T>, value: T): void
  inject<T>(key: ServiceKey<T>): T | undefined
  registerPublicFile(relPath: string): void
}

export interface CreateAppContextOptions {
  root: string
  outDir: string
  publicDir: string
  assetPrefix: string
  site?: string | undefined
  dev: boolean
  nodeEnv?: string | undefined
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
    ...(options.nodeEnv !== undefined ? { nodeEnv: options.nodeEnv } : {}),
    // Keyed by name: the natively loaded config and the bundled app each hold their own key object.
    provide<T>(key: ServiceKey<T>, value: T): void {
      services.set(key.name, value)
    },
    inject<T>(key: ServiceKey<T>): T | undefined {
      return services.get(key.name) as T | undefined
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
