// Kay v2 SSR runtime: flat string concatenation with fast-path escaping and zero-overhead islands.

import type { Html, HydrateStrategy, KayChild } from '../jsx-runtime'
import { isBlockedAttr, isStringBoolAttr, isUnsafeUrlAttr } from '../attrs'
import { renderOnServer } from '../reactivity/index'
import { styleText } from '../style'
import { assertRenderable } from '../unrenderable'
import { currentRenderContext, KAY_STREAM_SCRIPT, renderIsland } from './context'
import { keepScrollTag } from './navigation'
export { ssrStyleBlock } from './context'

export const KAY_ISLAND_STYLE = 'kay-island,kay-slot{display:contents}'
export const KAY_SUSPENSE_STYLE = 'kay-s{display:contents}'

export const RAW_HTML = Symbol.for('kay.html')

function isRawHtml(value: unknown): value is Html {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[RAW_HTML] === true && '__html' in value
}

const ESC_TEXT = /[&<>]/
const ESC_ATTR = /[&"<>]/
const bunEscape = typeof Bun !== 'undefined' && typeof Bun.escapeHTML === 'function' ? Bun.escapeHTML : undefined

function escText(str: string): string {
  if (bunEscape !== undefined)
    return bunEscape(str)
  if (!ESC_TEXT.test(str))
    return str
  return str.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function esc(value: unknown): string {
  if (typeof value === 'string')
    return escText(value)
  if (typeof value === 'number')
    return String(value)
  if (value == null || typeof value === 'boolean')
    return ''
  if (isRawHtml(value))
    return value.__html
  if (Array.isArray(value)) {
    let out = ''
    for (let i = 0; i < value.length; i++)
      out += esc(value[i])
    return out
  }
  assertRenderable(value, 'text')
  return escText(String(value))
}

export function ssrRaw(value: unknown): string {
  if (value == null || value === false)
    return ''
  if (isRawHtml(value))
    return String(value.__html)
  if (typeof value === 'object' && '__html' in value)
    throw new TypeError(UNBRANDED_INNER_HTML)
  return String(value)
}

/** React's `{ __html }` shape reaching innerHTML unbranded: kay would print `[object Object]`. */
const UNBRANDED_INNER_HTML = 'kay: innerHTML takes the HTML string, got a { __html } object; pass the string, or raw(html) for a value typed Html.'

const CLOSE_STYLE_RE = /<\/(style)/gi
const SCRIPT_UNSAFE_RE = /<(\/script|script|!--)/gi

/** Emits raw text inside `<style>` or `<script>` without HTML entity escaping, neutralizing dangerous script/style sequences. */
export function ssrRawText(tag: 'style' | 'script', value: unknown): string {
  if (value == null || typeof value === 'boolean')
    return ''
  if (Array.isArray(value)) {
    let out = ''
    for (let i = 0; i < value.length; i++)
      out += ssrRawText(tag, value[i])
    return out
  }
  const str = isRawHtml(value) ? String(value.__html) : String(value)
  if (tag === 'script') {
    return str.replace(SCRIPT_UNSAFE_RE, (_, body: string) =>
      body.charCodeAt(0) === 47 ? `<\\${body}` : `\\u003c${body}`)
  }
  return str.replace(CLOSE_STYLE_RE, '<\\/$1')
}

export function escAttr(value: unknown): string {
  const str = String(value)
  if (bunEscape !== undefined)
    return bunEscape(str)
  if (!ESC_ATTR.test(str))
    return str
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

// `<`, then the two line separators, built from their code points so the source shows no invisible character.
const SCRIPT_JSON_RE = new RegExp(`[<${String.fromCharCode(0x2028, 0x2029)}]`, 'g')

/** JSON text made safe inside a `<script>` element: `<` can no longer close it or open a comment, and U+2028 and U+2029 cannot end a line of script. */
export function escJson(json: string): string {
  return json.replace(SCRIPT_JSON_RE, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export function raw(html: string): Html {
  return { __html: html, [RAW_HTML]: true } as unknown as Html
}

export function ssrAttr(name: string, value: unknown, tag?: string): string {
  if (value == null || isBlockedAttr(name))
    return ''
  if (typeof value === 'boolean') {
    if (isStringBoolAttr(name))
      return ` ${name}="${value ? 'true' : 'false'}"`
    return value ? ` ${name}` : ''
  }
  if (isUnsafeUrlAttr(name, value, tag)) {
    if (process.env.NODE_ENV !== 'production')
      console.warn(`kay: dropped unsafe URL on <${tag ?? 'element'} ${name}>.`)
    return ''
  }
  assertRenderable(value, name)
  return ` ${name}="${escAttr(value)}"`
}

export function ssrStyle(value: unknown): string {
  if (value == null || value === false)
    return ''
  if (typeof value === 'string')
    return ` style="${escAttr(value)}"`
  if (typeof value === 'object') {
    const out = styleText(value as Record<string, unknown>)
    return out === '' ? '' : ` style="${escAttr(out)}"`
  }
  return ''
}

const SPREAD_DANGEROUS_HTML = 'kay: dangerouslySetInnerHTML in a spread: write innerHTML={html} on the element.'

export function ssrSpread(props: Record<string, unknown> | null | undefined, tag?: string): string {
  if (props == null || typeof props !== 'object')
    return ''
  let out = ''
  for (const [rawKey, value] of Object.entries(props)) {
    if (rawKey === 'key' || rawKey === 'ref' || rawKey === '$hydrate' || rawKey === 'children')
      continue
    if (rawKey === 'dangerouslySetInnerHTML')
      throw new TypeError(SPREAD_DANGEROUS_HTML)
    const name = rawKey === 'className' ? 'class' : rawKey === 'htmlFor' ? 'for' : rawKey
    if (isBlockedAttr(name))
      continue
    out += name === 'style' ? ssrStyle(value) : ssrAttr(name, value, tag)
  }
  return out
}

export function ssrLoop<T>(items: Iterable<T> | null | undefined | false, render: (item: T, index: number, array: readonly T[]) => string): string {
  if (!items)
    return ''
  const list: readonly T[] = Array.isArray(items) ? items : [...items]
  let out = ''
  for (let i = 0; i < list.length; i++)
    out += render(list[i] as T, i, list)
  return out
}

export function ssrChild(value: KayChild): string {
  if (typeof value === 'string')
    return esc(value)
  if (typeof value === 'number')
    return String(value)
  if (value == null || typeof value === 'boolean')
    return ''
  if (isRawHtml(value))
    return value.__html
  if (Array.isArray(value)) {
    let out = ''
    for (let i = 0; i < value.length; i++)
      out += ssrChild(value[i])
    return out
  }
  assertRenderable(value, 'text')
  return esc(String(value))
}

function serializeIslandProps(props: Record<string, unknown>): string {
  return JSON.stringify(props, function (this: Record<string, unknown>, key: string, value: unknown) {
    const orig = key !== '' && this != null && typeof this === 'object' ? this[key] : value
    if (orig === undefined)
      return Array.isArray(this) ? { __k: 'u', v: 0 } : value
    if (typeof orig === 'number') {
      if (!Number.isFinite(orig))
        return { __k: 'N', v: String(orig) }
      if (Object.is(orig, -0))
        return { __k: 'N', v: '-0' }
      return value
    }
    if (orig instanceof Date)
      return { __k: 'D', v: Number.isNaN(orig.getTime()) ? 'NaN' : orig.toISOString() }
    if (orig instanceof Set)
      return { __k: 'S', v: [...orig] }
    if (orig instanceof Map)
      return { __k: 'M', v: [...orig.entries()] }
    if (orig instanceof URL)
      return { __k: 'U', v: orig.href }
    if (orig instanceof RegExp)
      return { __k: 'R', v: [orig.source, orig.flags] }
    if (typeof orig === 'bigint')
      return { __k: 'B', v: orig.toString() }
    if (isRawHtml(orig))
      throw new TypeError(`kay: island prop "${key}" is server-rendered JSX, which cannot reach the browser; pass it as children, or build it inside the island.`)
    if (typeof orig === 'function')
      throw new TypeError(`kay: island prop "${key}" is a function, which cannot reach the browser; define it inside the island, or import it there.`)
    if (typeof orig === 'object' && orig !== null && 'peek' in orig && 'value' in orig)
      throw new TypeError(`kay: island prop "${key}" is a signal; pass ${key}.value, or import the signal in the island from a shared module.`)
    if (typeof orig === 'object' && orig !== null && !Array.isArray(orig) && Object.hasOwn(orig, '__k'))
      return { __k: 'O', v: Object.entries(orig).filter(([, x]) => x !== undefined) }
    return value
  })
}

let fallbackIslandDepth = 0

function getIslandDepth(): number {
  const ctx = currentRenderContext()
  return ctx !== undefined ? ctx.islandDepth : fallbackIslandDepth
}

export function recordRenderedIsland(chunk: string, hydrate?: HydrateStrategy): void {
  const ctx = currentRenderContext()
  if (ctx === undefined)
    return
  ctx.hasIslands = true
  const eager = hydrate === undefined || hydrate === 'load'
  if (eager)
    ctx.renderedIslands.set(chunk, true)
  else if (!ctx.renderedIslands.has(chunk))
    ctx.renderedIslands.set(chunk, false)
}

export function ssrInIsland(render: () => string, chunk?: string, hydrate?: HydrateStrategy, name = 'island'): string {
  const ctx = currentRenderContext()
  if (ctx !== undefined) {
    if (chunk !== undefined && ctx.islandDepth === 0)
      recordRenderedIsland(chunk, hydrate)
    ctx.islandDepth++
    try {
      return renderOnServer(ctx.islandDepth === 1 ? () => renderIsland(ctx, name, render) : render)
    }
    finally {
      ctx.islandDepth--
    }
  }
  fallbackIslandDepth++
  try {
    return renderOnServer(render)
  }
  finally {
    fallbackIslandDepth--
  }
}


/** Lazily evaluates non-async component children on first read inside the component's dynamic context, memoizing the result. */
export function ssrChildProp<P extends Record<string, unknown>>(props: P, fn: () => Html): P {
  let cached: Html | undefined
  let evaluated = false
  return Object.defineProperty(props, 'children', {
    enumerable: true,
    configurable: true,
    get() {
      if (!evaluated) {
        evaluated = true
        cached = fn()
      }
      return cached
    },
  })
}

export interface TrackedSlot {
  prop: Html
  html: string
  used: boolean
}

/** Wraps server-rendered island children in `<kay-slot>` and tracks whether the island emitted them during SSR. */
export function ssrSlot(html: string): TrackedSlot {
  const slot: TrackedSlot = {
    html,
    used: false,
    prop: null as unknown as Html,
  }
  slot.prop = Object.defineProperty(
    { [RAW_HTML]: true },
    '__html',
    {
      enumerable: true,
      get() {
        slot.used = true
        return `<kay-slot>${html}</kay-slot>`
      },
    },
  ) as unknown as Html
  return slot
}

function renderIslandBody(
  ctx: ReturnType<typeof currentRenderContext>,
  render: (() => string) | undefined,
  hydrate: HydrateStrategy | undefined,
  name: string | undefined,
  slot: TrackedSlot | undefined,
): { idAttr: string, inner: string, hiddenSlot: string } {
  let idAttr = ''
  let inner = ''
  if (render !== undefined && hydrate !== 'client') {
    if (ctx !== undefined) {
      const prevPrefix = ctx.idPrefix
      const prevSeq = ctx.idSeq
      const islandPrefix = `i${ctx.islandSeq++}-`
      ctx.idPrefix = islandPrefix
      ctx.idSeq = 0
      try {
        inner = ssrInIsland(render, undefined, undefined, name)
        if (ctx.idSeq > 0)
          idAttr = ` i="${islandPrefix}"`
      }
      finally {
        ctx.idPrefix = prevPrefix
        ctx.idSeq = prevSeq
      }
    }
    else {
      inner = ssrInIsland(render, undefined, undefined, name)
    }
  }

  const hiddenSlot = slot !== undefined && !slot.used && slot.html !== ''
    ? `<template data-kay-slot>${slot.html}</template>`
    : ''
  return { idAttr, inner, hiddenSlot }
}

export function ssrIslandStatic(
  chunk: string,
  openTag: string,
  render: (() => string) | undefined,
  hydrate?: HydrateStrategy,
  name?: string,
  slot?: TrackedSlot,
): string {
  if (getIslandDepth() > 0)
    return render !== undefined ? render() : ''

  const ctx = currentRenderContext()
  if (ctx !== undefined)
    recordRenderedIsland(chunk, hydrate)

  const { idAttr, inner, hiddenSlot } = renderIslandBody(ctx, render, hydrate, name, slot)
  const tag = idAttr === '' ? openTag : `${openTag.slice(0, -1)}${idAttr}>`
  return `${tag}${inner}${hiddenSlot}</kay-island>`
}


export function ssrIsland(
  chunk: string,
  render: () => string,
  props: Record<string, unknown>,
  hydrate?: HydrateStrategy,
  scriptProps = false,
  name?: string,
  slot?: TrackedSlot,
): string {
  if (getIslandDepth() > 0)
    return render()

  const ctx = currentRenderContext()
  if (ctx !== undefined)
    recordRenderedIsland(chunk, hydrate)

  let propsAttr = ''
  let propsScript = ''
  if (Object.keys(props).length > 0) {
    const json = serializeIslandProps(props)
    if (ctx !== undefined && json.includes('"__k":'))
      ctx.revives = true
    if (scriptProps)
      propsScript = `<script type="application/json" data-kay-props>${escJson(json)}</script>`
    else
      propsAttr = ` p="${escAttr(json)}"`
  }
  const hydrateAttr = hydrate !== undefined && hydrate !== 'load'
    ? ` h="${escAttr(hydrate)}"`
    : ''

  const { idAttr, inner, hiddenSlot } = renderIslandBody(ctx, render, hydrate, name, slot)
  return `<kay-island c="${escAttr(chunk)}"${propsAttr}${hydrateAttr}${idAttr}>${inner}${hiddenSlot}${propsScript}</kay-island>`
}

export interface DocumentOptions {
  body: string
  head?: string | undefined
  headTags?: Iterable<string> | undefined
  lang?: string | undefined
  htmlAttrs?: Record<string, string> | undefined
  runtimeScript?: string | undefined
  alwaysLoadRuntime?: boolean | undefined
  /** Set on a route that renders a `<Region>`: the plugins' `regionClientEntry` bundle. */
  regionScript?: string | undefined
  preloadChunks?: Iterable<string> | undefined
  /** Script URL to the chunks it imports statically, preloaded with it: the browser then fetches them all at once. */
  chunkImports?: Readonly<Record<string, readonly string[]>> | undefined
  styles?: Iterable<string> | undefined
  hasIslands?: boolean | undefined
  hasSuspense?: boolean | undefined
  // The head markup every page shares for the `navigation` settings: see `createNavigation`.
  navigation?: string | undefined
}

export function renderDocument(options: DocumentOptions): string {
  const { body, head = '', headTags, lang = 'en', htmlAttrs, runtimeScript, alwaysLoadRuntime, regionScript, preloadChunks, chunkImports, styles, hasIslands, hasSuspense, navigation } = options
  let headExtra = head

  if (headTags !== undefined) {
    for (const tag of headTags)
      headExtra += tag
  }

  if (styles !== undefined) {
    for (const href of styles)
      headExtra += `<link rel="stylesheet" href="${escAttr(href)}">`
  }

  if (navigation !== undefined)
    headExtra += navigation

  const loadsRuntime = runtimeScript !== undefined && (hasIslands || alwaysLoadRuntime)
  const preloads = new Set<string>()
  const preload = (script: string, self: boolean): void => {
    if (self)
      preloads.add(script)
    for (const dep of chunkImports?.[script] ?? [])
      preloads.add(dep)
  }
  if (hasIslands) {
    headExtra += `<style>${KAY_ISLAND_STYLE}</style>`
    for (const chunk of preloadChunks ?? [])
      preload(chunk, true)
  }
  if (loadsRuntime)
    preload(runtimeScript, false)
  for (const href of preloads)
    headExtra += `<link rel="modulepreload" href="${escAttr(href)}">`

  if (hasSuspense)
    headExtra += `<style>${KAY_SUSPENSE_STYLE}</style><script>${KAY_STREAM_SCRIPT}</script>`

  if (loadsRuntime)
    headExtra += `<script type="module" src="${escAttr(runtimeScript)}"></script>`
  if (regionScript !== undefined)
    headExtra += `<script type="module" src="${escAttr(regionScript)}"></script>`

  let attrStr = ''
  const effectiveLang = htmlAttrs?.lang ?? lang
  attrStr += ` lang="${escAttr(effectiveLang)}"`
  if (htmlAttrs !== undefined) {
    for (const [k, v] of Object.entries(htmlAttrs)) {
      if (k !== 'lang' && !isBlockedAttr(k))
        attrStr += ` ${k}="${escAttr(v)}"`
    }
  }

  return `<!DOCTYPE html><html${attrStr}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${headExtra}</head><body>${body}${keepScrollTag(body)}</body></html>`
}
