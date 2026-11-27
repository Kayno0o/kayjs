// Universal component context (createContext / useContext) and hydration-safe useId().
// Browser-pure: zero Node imports. SSR wires its per-request AsyncLocalStorage bridge via registerServerContextBridge().

import type { KayChild } from './jsx-runtime'
import type { IdScope, Owner } from './reactivity/index'
import { catchBoundary } from './dom/extras'
import { createOwner, getOwner, runWithOwner } from './reactivity/index'

export interface RegionProps {
  name: string
  /** The element tag, `div` by default. */
  as?: string
  children?: KayChild
  [attribute: string]: unknown
}

export interface ConsentGateProps {
  /** Consent category required to render `children` (e.g. `'analytics'`, `'media'`). */
  category: string
  /** Rendered when consent for `category` has not been granted. */
  fallback?: KayChild
  children?: KayChild
}

export interface CatchProps {
  /** Rendered in place of `children` when they throw; a function gets the error and a `retry` that renders the children again (a no-op on the server). */
  fallback?: KayChild | ((error: unknown, retry: () => void) => KayChild)
  children?: KayChild
}

export interface ServerContextBridge {
  region(props: RegionProps): KayChild
  consentGate(props: ConsentGateProps): KayChild
  getContext(key: symbol): { found: true, value: unknown } | undefined
  runWithContext<T>(key: symbol, value: unknown, fn: () => T): T
  nextId(): string | undefined
  head(props: { children?: KayChild }): KayChild
  suspense(props: { fallback?: KayChild, error?: KayChild | ((error: unknown) => KayChild), children?: KayChild | Promise<KayChild> }): KayChild
  catch(props: CatchProps): KayChild | Promise<KayChild>
}

const BRIDGE_KEY = Symbol.for('kay.server.context.bridge')

function getServerBridge(): ServerContextBridge | undefined {
  return (globalThis as Record<symbol, ServerContextBridge | undefined>)[BRIDGE_KEY]
}

/** Internal: registered by kay's SSR runtime on the server so `Head`, `Suspense`, `useContext`, and `useId` stay request-scoped without pulling `node:async_hooks` into client bundles. */
export function registerServerContextBridge(bridge: ServerContextBridge): void {
  ;(globalThis as Record<symbol, ServerContextBridge | undefined>)[BRIDGE_KEY] = bridge
}

/** Collects document `<head>` tags during SSR; no-op in the browser. */
export function Head(props: { children?: KayChild }): KayChild {
  const bridge = getServerBridge()
  return bridge !== undefined ? bridge.head(props) : null
}

/** Streaming SSR boundary: flushes `fallback` immediately and streams resolved async children. */
export function Suspense(props: { fallback?: KayChild, error?: KayChild | ((error: unknown) => KayChild), children?: KayChild | Promise<KayChild> }): KayChild {
  const bridge = getServerBridge()
  if (bridge !== undefined)
    return bridge.suspense(props)
  return props.children instanceof Promise ? (props.fallback ?? null) : (props.children ?? null)
}

/** Renders `fallback` in place of `children` when they throw, on the server and in an island; the app's `onError` hook still gets the error. */
export function Catch(props: CatchProps): KayChild | Promise<KayChild> {
  const bridge = getOwner() === undefined ? getServerBridge() : undefined
  if (bridge !== undefined)
    return bridge.catch(props)
  return catchBoundary(() => props.children, (error, retry) => {
    const fallback = props.fallback
    return typeof fallback === 'function' ? fallback(error, retry) : fallback
  }) as KayChild
}

/** A part of the page that a link or form with `data-kay-target` swaps alone: a request for it renders only its children. Server-only, like `Head`. */
export function Region(props: RegionProps): KayChild {
  const bridge = getServerBridge()
  return bridge !== undefined ? bridge.region(props) : null
}

/** Renders `children` on the server only when consent for `category` has been granted; otherwise renders `fallback`. Server-only, 0 KB browser JS. */
export function ConsentGate(props: ConsentGateProps): KayChild {
  const bridge = getServerBridge()
  return bridge !== undefined ? bridge.consentGate(props) : (props.fallback ?? null)
}

export interface Context<T> {
  readonly id: symbol
  readonly defaultValue: T
  Provider: (props: { value: T, children?: KayChild | (() => KayChild) }) => KayChild
}

function findOwnerContext(owner: Owner | undefined, key: symbol): { found: true, value: unknown } | undefined {
  for (let o = owner; o !== undefined; o = o.o) {
    if (o.cx !== undefined && o.cx.has(key))
      return { found: true, value: o.cx.get(key) }
  }
  return undefined
}

function findOwnerIdScope(owner: Owner | undefined): IdScope | undefined {
  for (let o = owner; o !== undefined; o = o.o) {
    if (o.id !== undefined)
      return o.id
  }
  return undefined
}

/** Run `fn` with `ctx` bound to `value` on both server (SSR) and browser (reactive owner tree). */
export function provideContext<T, R>(ctx: Context<T>, value: T, fn: () => R): R {
  const owner = getOwner()
  if (owner !== undefined) {
    const scope = createOwner(owner)
    ;(scope.cx ??= new Map()).set(ctx.id, value)
    return runWithOwner(scope, fn)
  }
  const bridge = getServerBridge()
  if (bridge !== undefined)
    return bridge.runWithContext(ctx.id, value, fn)
  return fn()
}

export function createContext<T>(defaultValue: T): Context<T> {
  const id = Symbol('kay.context')
  const ctx: Context<T> = {
    id,
    defaultValue,
    Provider(props) {
      return provideContext(ctx, props.value, () => {
        const c = props.children
        return typeof c === 'function' ? (c as () => KayChild)() : c
      })
    },
  }
  return ctx
}

export function useContext<T>(ctx: Context<T>): T {
  const owner = getOwner()
  if (owner !== undefined) {
    const hit = findOwnerContext(owner, ctx.id)
    if (hit !== undefined)
      return hit.value as T
  }
  const bridge = getServerBridge()
  if (bridge !== undefined) {
    const hit = bridge.getContext(ctx.id)
    if (hit !== undefined)
      return hit.value as T
  }
  return ctx.defaultValue
}

let fallbackIdSeq = 0

/** Generates a deterministic, hydration-safe unique ID scoped to the current island or SSR request. */
export function useId(prefix = 'k'): string {
  const scope = findOwnerIdScope(getOwner())
  if (scope !== undefined)
    return `${prefix}-${scope.p}${scope.n++}`
  const bridge = getServerBridge()
  const serverId = bridge?.nextId()
  if (serverId !== undefined)
    return `${prefix}-${serverId}`
  return `${prefix}-g${fallbackIdSeq++}`
}
