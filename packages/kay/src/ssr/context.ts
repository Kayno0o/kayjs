// Per-request SSR context for <Head> metadata, streaming <Suspense>, rendered island tracking,
// universal createContext/useContext, and deterministic hydration-safe useId().

import type { Html, KayChild } from '../jsx-runtime'
import { AsyncLocalStorage } from 'node:async_hooks'
import { registerServerContextBridge } from '../context'
import { raw, ssrChild } from './index'
import { Region } from './region'

export interface SettledChunk {
  html: string
  error?: unknown
}

export interface PendingChunk {
  id: number
  // Settles to the boundary's HTML, or to its error template and the error: it never rejects.
  settled: Promise<SettledChunk>
  renderError: (error: unknown) => string
}

export interface RenderContext {
  headParts: string[]
  title: string | undefined
  pending: PendingChunk[]
  nextId: number
  islandDepth: number
  islandSeq: number
  idPrefix: string
  idSeq: number
  contexts: Map<symbol, unknown>
  /** While an island renders, the contexts provided outside it, which the browser never sees. */
  outerContexts: Map<symbol, unknown> | undefined
  /** The island rendering, as its tag. */
  island: string | undefined
  /** Maps island chunk URL -> eager (true if hydrate is undefined/'load'). */
  renderedIslands: Map<string, boolean>
  hasIslands: boolean
  htmlAttrs: Record<string, string>
  /** The region a request asked for alone (`x-kay-region`). */
  region: string | undefined
  /** The requested region's HTML, once the page rendered it. */
  regionHtml: string | undefined
  regionNames: Set<string>
  /** The regions around the requested one: rendered through, their own HTML dropped. */
  regionAncestors: ReadonlySet<string>
  /** True while the requested region's children render: regions inside it render in full. */
  inTarget: boolean
  /** Compiler-emitted inline `<style>` contents rendered during this request, for CSP hashing. */
  inlineStyles: string[] | undefined
}

const STORAGE_KEY = Symbol.for('kay.render.storage')
const renderStorage: AsyncLocalStorage<RenderContext> = ((globalThis as Record<symbol, AsyncLocalStorage<RenderContext> | undefined>)[STORAGE_KEY] ??= new AsyncLocalStorage<RenderContext>())

registerServerContextBridge({
  getContext(key: symbol) {
    const ctx = renderStorage.getStore()
    if (ctx !== undefined && ctx.contexts.has(key))
      return { found: true, value: ctx.contexts.get(key) }
    if (ctx?.outerContexts?.has(key) === true)
      throw new Error(`kay: <${ctx.island}> reads a context provided outside the island, which the browser never sees; pass its value as a prop.`)
    return undefined
  },
  runWithContext<T>(key: symbol, value: unknown, fn: () => T): T {
    const ctx = renderStorage.getStore()
    if (ctx === undefined)
      return fn()
    const had = ctx.contexts.has(key)
    const prev = ctx.contexts.get(key)
    ctx.contexts.set(key, value)
    try {
      return fn()
    }
    finally {
      if (had)
        ctx.contexts.set(key, prev)
      else
        ctx.contexts.delete(key)
    }
  },
  nextId() {
    const ctx = renderStorage.getStore()
    if (ctx === undefined)
      return undefined
    return `${ctx.idPrefix}${ctx.idSeq++}`
  },
  region(props) {
    return Region(props)
  },
  head(props) {
    return Head(props)
  },
  suspense(props) {
    return Suspense(props)
  },
})

export function createRenderContext(region?: string, ancestors: ReadonlySet<string> = new Set()): RenderContext {
  return {
    headParts: [],
    title: undefined,
    pending: [],
    nextId: 0,
    islandDepth: 0,
    islandSeq: 0,
    idPrefix: '',
    idSeq: 0,
    contexts: new Map(),
    outerContexts: undefined,
    island: undefined,
    renderedIslands: new Map(),
    hasIslands: false,
    htmlAttrs: {},
    region,
    regionHtml: undefined,
    regionNames: new Set(),
    regionAncestors: ancestors,
    inTarget: false,
    inlineStyles: undefined,
  }
}

/** Records a compiler-emitted inline `<style>` block's CSS in the active RenderContext for CSP hashing. */
export function recordInlineStyle(css: string): void {
  const ctx = renderStorage.getStore()
  if (ctx === undefined || css === '')
    return
  if (ctx.inlineStyles === undefined)
    ctx.inlineStyles = [css]
  else if (!ctx.inlineStyles.includes(css))
    ctx.inlineStyles.push(css)
}

/** Emits compiler-authored `<style>` text unchanged while registering it for CSP hashing. */
export function ssrStyleBlock(css: string): string {
  recordInlineStyle(css)
  return css
}

// An island sees only the contexts provided inside it, as in the browser.
export function renderIsland(ctx: RenderContext, name: string, render: () => string): string {
  const outer = ctx.contexts
  ctx.contexts = new Map()
  ctx.outerContexts = outer
  ctx.island = name
  try {
    return render()
  }
  finally {
    ctx.contexts = outer
    ctx.outerContexts = undefined
    ctx.island = undefined
  }
}


export function runWithRenderContext<T>(ctx: RenderContext, fn: () => T): T {
  return renderStorage.run(ctx, fn)
}

export function currentRenderContext(): RenderContext | undefined {
  return renderStorage.getStore()
}

const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/gi

/** Collects document <head> tags during SSR; innermost <title> wins. */
export function Head(props: { children?: KayChild }): Html {
  const ctx = renderStorage.getStore()
  if (ctx === undefined)
    return raw('')

  let html = ssrChild(props.children)
  TITLE_RE.lastIndex = 0
  const titleMatch = TITLE_RE.exec(html)
  if (titleMatch !== null) {
    // Inner page renders before outer layouts, so the first (innermost) <title> wins.
    ctx.title ??= titleMatch[0]
    TITLE_RE.lastIndex = 0
    html = html.replace(TITLE_RE, '')
  }
  if (html !== '')
    ctx.headParts.push(html)

  return raw('')
}

export function renderCollectedHead(ctx: RenderContext): string {
  let out = ctx.title ?? ''
  for (let i = 0; i < ctx.headParts.length; i++)
    out += ctx.headParts[i]
  return out
}

/**
 * Streaming SSR boundary: flushes `fallback` immediately and streams resolved async children
 * with a zero-dependency inline swap script. Islands inside streamed chunks hydrate automatically!
 */
export function Suspense(props: { fallback?: KayChild, error?: KayChild | ((error: unknown) => KayChild), children?: KayChild | Promise<KayChild> }): Html {
  const ctx = renderStorage.getStore()
  const child = props.children

  if (!(child instanceof Promise))
    return raw(ssrChild(child))

  if (ctx === undefined)
    return raw(ssrChild(props.fallback))

  const id = ctx.nextId++
  // Capture RenderContext so timeout / error fallback renders still run inside the request context.
  const renderError = (error: unknown): string => {
    try {
      return runWithRenderContext(ctx, () => ssrChild(typeof props.error === 'function' ? props.error(error) : props.error))
    }
    catch {
      return ''
    }
  }
  ctx.pending.push({ id, settled: settle(ctx, child, renderError), renderError })

  const fallbackHtml = ssrChild(props.fallback)
  return raw(`<kay-s id="k-s-${id}">${fallbackHtml}</kay-s>`)
}

async function settle(ctx: RenderContext, child: Promise<KayChild>, renderError: (error: unknown) => string): Promise<SettledChunk> {
  try {
    const resolved = await child
    return { html: runWithRenderContext(ctx, () => ssrChild(resolved)) }
  }
  catch (error) {
    return { html: renderError(error), error }
  }
}

/** Fixed streaming swap bootstrap (constant content -> deterministic SHA-256 CSP hash, zero per-chunk inline scripts). */
export const KAY_STREAM_SCRIPT = `(()=>{const w=n=>{if(n.nodeType===1&&n.tagName==='TEMPLATE'&&n.dataset.ks){const s=document.getElementById('k-s-'+n.dataset.ks);if(s){s.replaceWith(n.content);n.remove()}}};const o=new MutationObserver(ms=>{for(const m of ms)for(const n of m.addedNodes)w(n)});o.observe(document.documentElement,{childList:true,subtree:true});document.addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('template[data-ks]').forEach(w);o.disconnect()},{once:true})})()`

export function streamChunkScript(id: number, resolvedHtml: string): string {
  return `<template data-ks="${id}">${resolvedHtml}</template>`
}
