// Kay v2 SSR runtime: flat string concatenation with fast-path escaping and zero-overhead islands.

import type { Html, HydrateStrategy, KayChild } from '../jsx-runtime'
import { KAY_STREAM_SCRIPT } from './context'

export const KAY_ISLAND_STYLE = 'kay-island,kay-slot{display:contents}'
export const KAY_SUSPENSE_STYLE = 'kay-s{display:contents}'

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
  if (typeof value === 'object' && '__html' in value)
    return (value as Html).__html
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
  if (typeof value === 'object' && '__html' in value)
    return String((value as Html).__html)
  return String(value)
}

const CLOSE_STYLE_RE = /<\/(style)/gi
const CLOSE_SCRIPT_RE = /<\/(script)/gi

/** Emits raw text inside `<style>` or `<script>` without HTML entity escaping, neutralizing only its closing tag. */
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
    : typeof value === 'object' && '__html' in value
      ? String((value as Html).__html)
      : String(value)
  return str.replace(tag === 'script' ? CLOSE_SCRIPT_RE : CLOSE_STYLE_RE, '<\\/$1')
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
  return { __html: html }
}

export function ssrAttr(name: string, value: unknown): string {
  if (value == null || value === false)
    return ''
  if (value === true)
    return ` ${name}`
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

const SPREAD_EVENT_RE = /^on[A-Z]/

export function ssrSpread(props: Record<string, unknown> | null | undefined): string {
  if (props == null || typeof props !== 'object')
    return ''
  let out = ''
  for (const [rawKey, value] of Object.entries(props)) {
    if (rawKey === 'key' || rawKey === 'ref' || rawKey === '$hydrate' || rawKey === 'children' || SPREAD_EVENT_RE.test(rawKey))
      continue
    const name = rawKey === 'className' ? 'class' : rawKey === 'htmlFor' ? 'for' : rawKey
    out += name === 'style' ? ssrStyle(value) : ssrAttr(name, value)
  }
  return out
}

export function ssrLoop<T>(items: Iterable<T> | null | undefined | false, render: (item: T, index: number) => string): string {
  if (!items)
    return ''
  let out = ''
  if (Array.isArray(items)) {
    for (let i = 0; i < items.length; i++)
      out += render(items[i] as T, i)
    return out
  }
  let i = 0
  for (const item of items)
    out += render(item, i++)
  return out
}

export function ssrChild(value: KayChild): string {
  if (typeof value === 'string')
    return esc(value)
  if (typeof value === 'number')
    return String(value)
  if (value == null || typeof value === 'boolean')
    return ''
  if (typeof value === 'object' && '__html' in value)
    return (value as Html).__html
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

export function ssrIsland(
  _id: string,
  chunk: string,
  render: () => string,
  props: Record<string, unknown>,
  hydrate?: HydrateStrategy,
): string {
  const propsAttr = Object.keys(props).length > 0
    ? ` p="${escAttr(serializeIslandProps(props))}"`
    : ''
  const hydrateAttr = hydrate !== undefined && hydrate !== 'load'
    ? ` h="${escAttr(hydrate)}"`
    : ''
  const inner = hydrate === 'client' ? '' : render()

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
