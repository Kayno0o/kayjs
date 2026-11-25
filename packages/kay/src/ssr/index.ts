// Kay v2 SSR runtime: flat string concatenation with fast-path escaping and zero-overhead islands.

import type { Html, HydrateStrategy, KayChild } from '../jsx-runtime'
import { currentRenderContext, KAY_STREAM_SCRIPT } from './context'

export const KAY_ISLAND_STYLE = 'kay-island,kay-slot{display:contents}'
export const KAY_SUSPENSE_STYLE = 'kay-s{display:contents}'

export const RAW_HTML = Symbol.for('kay.html')

function isRawHtml(value: unknown): value is Html {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[RAW_HTML] === true && '__html' in value
}

const ESC_TEXT = /[&<>]/
const ESC_ATTR = /[&"<>]/
const bunEscape = typeof Bun !== 'undefined' && typeof Bun.escapeHTML === 'function' ? Bun.escapeHTML : undefined

export function esc(value: unknown): string {
  if (typeof value === 'string') {
    if (bunEscape !== undefined)
      return bunEscape(value)
    if (!ESC_TEXT.test(value))
      return value
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  }
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
  const str = String(value)
  if (bunEscape !== undefined)
    return bunEscape(str)
  if (!ESC_TEXT.test(str))
    return str
  return str.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function ssrRaw(value: unknown): string {
  if (value == null || value === false)
    return ''
  if (isRawHtml(value))
    return String(value.__html)
  return String(value)
}

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
  const str = typeof value === 'string'
    ? value
    : isRawHtml(value)
      ? String(value.__html)
      : String(value)
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

export function raw(html: string): Html {
  return { __html: html, [RAW_HTML]: true } as Html
}

const VALID_ATTR_NAME = /^[A-Za-z_:][-\w:.]*$/
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href'])
const UNSAFE_URL_RE = /^(?:javascript|vbscript):/i
const STRING_BOOL_ATTRS = new Set(['draggable', 'spellcheck', 'contenteditable'])

function isBlockedAttr(name: string): boolean {
  if (!VALID_ATTR_NAME.test(name))
    return true
  const lower = name.toLowerCase()
  return lower.startsWith('on') || lower === 'innerhtml' || lower === 'srcdoc'
}

function isStringBoolAttr(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('aria-') || STRING_BOOL_ATTRS.has(lower)
}

function isUnsafeUrlAttr(name: string, value: unknown): boolean {
  if (!URL_ATTRS.has(name.toLowerCase()))
    return false
  return UNSAFE_URL_RE.test(String(value).replace(/[\u0000-\u0020]+/g, ''))
}

export function ssrAttr(name: string, value: unknown): string {
  if (value == null || isBlockedAttr(name))
    return ''
  if (typeof value === 'boolean') {
    if (isStringBoolAttr(name))
      return ` ${name}="${value ? 'true' : 'false'}"`
    return value ? ` ${name}` : ''
  }
  if (isUnsafeUrlAttr(name, value))
    return ''
  return ` ${name}="${escAttr(value)}"`
}

export function ssrStyle(value: unknown): string {
  if (value == null || value === false)
    return ''
  if (typeof value === 'string')
    return ` style="${escAttr(value)}"`
  if (typeof value === 'object') {
    let out = ''
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v != null && v !== '')
        out += `${k}:${v};`
    }
    return out === '' ? '' : ` style="${escAttr(out)}"`
  }
  return ''
}

export function ssrSpread(props: Record<string, unknown> | null | undefined): string {
  if (props == null || typeof props !== 'object')
    return ''
  let out = ''
  for (const [rawKey, value] of Object.entries(props)) {
    if (rawKey === 'key' || rawKey === 'ref' || rawKey === '$hydrate' || rawKey === 'children')
      continue
    const name = rawKey === 'className' ? 'class' : rawKey === 'htmlFor' ? 'for' : rawKey
    if (isBlockedAttr(name))
      continue
    out += name === 'style' ? ssrStyle(value) : ssrAttr(name, value)
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
  return esc(String(value))
}

function serializeIslandProps(props: Record<string, unknown>): string {
  return JSON.stringify(props, function (this: Record<string, unknown>, key: string, value: unknown) {
    const orig = key !== '' && this != null && typeof this === 'object' ? this[key] : value
    if (orig instanceof Date)
      return { __k: 'D', v: orig.toISOString() }
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
    return value
  })
}

let fallbackIslandDepth = 0

function getIslandDepth(): number {
  const ctx = currentRenderContext()
  return ctx !== undefined ? ctx.islandDepth : fallbackIslandDepth
}

export function ssrInIsland(render: () => string): string {
  const ctx = currentRenderContext()
  if (ctx !== undefined) {
    ctx.islandDepth++
    try {
      return render()
    }
    finally {
      ctx.islandDepth--
    }
  }
  fallbackIslandDepth++
  try {
    return render()
  }
  finally {
    fallbackIslandDepth--
  }
}

export function ssrIsland(
  _id: string,
  chunk: string,
  render: () => string,
  props: Record<string, unknown>,
  hydrate?: HydrateStrategy,
): string {
  if (getIslandDepth() > 0)
    return render()

  const propsAttr = Object.keys(props).length > 0
    ? ` p="${escAttr(serializeIslandProps(props))}"`
    : ''
  const hydrateAttr = hydrate !== undefined && hydrate !== 'load'
    ? ` h="${escAttr(hydrate)}"`
    : ''
  const inner = hydrate === 'client' ? '' : ssrInIsland(render)

  return `<kay-island c="${escAttr(chunk)}"${propsAttr}${hydrateAttr}>${inner}</kay-island>`
}

export interface DocumentOptions {
  body: string
  head?: string | undefined
  headTags?: Iterable<string> | undefined
  lang?: string | undefined
  runtimeScript?: string | undefined
  alwaysLoadRuntime?: boolean | undefined
  preloadChunks?: Iterable<string> | undefined
  styles?: Iterable<string> | undefined
  hasIslands?: boolean | undefined
  hasSuspense?: boolean | undefined
}

export function renderDocument(options: DocumentOptions): string {
  const { body, head = '', headTags, lang = 'en', runtimeScript, alwaysLoadRuntime, preloadChunks, styles, hasIslands, hasSuspense } = options
  let headExtra = head

  if (headTags !== undefined) {
    for (const tag of headTags)
      headExtra += tag
  }

  if (styles !== undefined) {
    for (const href of styles)
      headExtra += `<link rel="stylesheet" href="${escAttr(href)}">`
  }

  if (hasIslands) {
    headExtra += `<style>${KAY_ISLAND_STYLE}</style>`
    if (preloadChunks !== undefined) {
      for (const href of preloadChunks)
        headExtra += `<link rel="modulepreload" href="${escAttr(href)}">`
    }
  }

  if (hasSuspense)
    headExtra += `<style>${KAY_SUSPENSE_STYLE}</style><script>${KAY_STREAM_SCRIPT}</script>`

  if (runtimeScript !== undefined && (hasIslands || alwaysLoadRuntime))
    headExtra += `<script type="module" src="${escAttr(runtimeScript)}"></script>`

  return `<!DOCTYPE html><html lang="${escAttr(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${headExtra}</head><body>${body}</body></html>`
}
