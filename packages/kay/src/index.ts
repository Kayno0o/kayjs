export { createContext, Head, provideContext, Suspense, useContext, useId } from './context'
export type { Context } from './context'
export {
  batch,
  computed,
  effect,
  getOwner,
  onCleanup,
  onMount,
  root,
  signal,
  untrack,
} from './reactivity/index'
export type { Owner, ReadonlySignal, Signal } from './reactivity/index'
export { selector } from './reactivity/selector'
export type { Selector } from './reactivity/selector'
export { snapshot, store } from './reactivity/store'
export type { Component, Html, HydrateStrategy, KayChild } from './jsx-runtime'
export type { ExtractRouteParams, KayLocals, LayoutProps, LoaderData, LoaderFn, NotFoundResult, PageProps, RouteContext } from './server/index'

import type { Component, HydrateStrategy } from './jsx-runtime'

export interface IslandOptions {
  hydrate?: HydrateStrategy | undefined
}

/** Optional component-level hydration metadata helper. */
export function island<P>(component: Component<P>, options: IslandOptions = {}): Component<P> & { $hydrate?: HydrateStrategy } {
  const tagged = component as Component<P> & { $hydrate?: HydrateStrategy }
  if (options.hydrate !== undefined)
    tagged.$hydrate = options.hydrate
  return tagged
}
