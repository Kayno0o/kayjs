// Per-request SSR context for <Head> metadata collection and streaming <Suspense> boundaries.
// Zero cost on pages that don't use <Head> or <Suspense>.

import type { Html, KayChild } from '../jsx-runtime'
import { AsyncLocalStorage } from 'node:async_hooks'
import { raw, ssrChild } from './index'

export interface PendingChunk {
  id: number
  promise: Promise<string>
}

export interface RenderContext {
  headParts: string[]
  title: string | undefined
  pending: PendingChunk[]
  nextId: number
}

const STORAGE_KEY = Symbol.for('kay.render.storage')
const renderStorage: AsyncLocalStorage<RenderContext> = ((globalThis as Record<symbol, AsyncLocalStorage<RenderContext> | undefined>)[STORAGE_KEY] ??= new AsyncLocalStorage<RenderContext>())

export function createRenderContext(): RenderContext {
  return { headParts: [], title: undefined, pending: [], nextId: 0 }
}

export function runWithRenderContext<T>(ctx: RenderContext, fn: () => T): T {
  return renderStorage.run(ctx, fn)
}

export function currentRenderContext(): RenderContext | undefined {
  return renderStorage.getStore()
}

const TITLE_RE = /<title>([\s\S]*?)<\/title>/i

/** Collects document <head> tags during SSR; innermost <title> wins. */
export function Head(props: { children?: KayChild }): Html {
  const ctx = renderStorage.getStore()
  if (ctx === undefined)
    return raw('')

  let html = ssrChild(props.children)
  const titleMatch = TITLE_RE.exec(html)
  if (titleMatch !== null) {
    // Inner page renders before outer layouts, so the first (innermost) <title> wins.
    ctx.title ??= titleMatch[0]
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
export function Suspense(props: { fallback?: KayChild, children?: KayChild | Promise<KayChild> }): Html {
  const ctx = renderStorage.getStore()
  const child = props.children

  if (!(child instanceof Promise))
    return raw(ssrChild(child))

  if (ctx === undefined)
    return raw(ssrChild(props.fallback))

  const id = ctx.nextId++
  ctx.pending.push({
    id,
    promise: child.then(resolved => ssrChild(resolved)),
  })

  const fallbackHtml = ssrChild(props.fallback)
  return raw(`<kay-s id="k-s-${id}">${fallbackHtml}</kay-s>`)
}

/** Fixed streaming swap bootstrap (constant content -> deterministic SHA-256 CSP hash, zero per-chunk inline scripts). */
export const KAY_STREAM_SCRIPT = `(()=>{const w=n=>{if(n.nodeType===1&&n.tagName==='TEMPLATE'&&n.dataset.ks){const s=document.getElementById('k-s-'+n.dataset.ks);if(s){s.replaceWith(n.content);n.remove()}}};const o=new MutationObserver(ms=>{for(const m of ms)for(const n of m.addedNodes)w(n)});o.observe(document.documentElement,{childList:true,subtree:true});document.addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('template[data-ks]').forEach(w);o.disconnect()},{once:true})})()`

export function streamChunkScript(id: number, resolvedHtml: string): string {
  return `<template data-ks="${id}">${resolvedHtml}</template>`
}
