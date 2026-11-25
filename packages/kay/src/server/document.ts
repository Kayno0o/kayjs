// What every rendered document shares: its HTML headers, the plugins' `head` hooks and `transformHtml` passes, and the islands it rendered.

import type { DocumentHeadContext, KayPlugin, ServerErrorInfo } from '../plugins/index'
import type { RenderContext } from '../ssr/context'
import type { RequestContext } from './http'
import type { SecurityHeadersOptions, TrustProxy } from './security'
import { extractRenderedIslands, makeRequestContext } from './http'
import { KAY_ISLAND_STYLE_HASH, KAY_STREAM_SCRIPT_HASH, KAY_SUSPENSE_STYLE_HASH, resolveCspPolicy, withCspHashes } from './security'

const TITLE_INNER_RE = /^<title\b[^>]*>([\s\S]*?)<\/title>$/i

export type HtmlHeaders = (hasIslands: boolean, hasSuspense: boolean, isDynamic: boolean) => Record<string, string>

// HTML headers, one set per (dynamic, islands, suspense) combination: the CSP only gains the hashes a page needs.
export function createHtmlHeaders(security: SecurityHeadersOptions | false | undefined, securityRecord: Record<string, string>): HtmlHeaders {
  const baseCsp = resolveCspPolicy(security)
  const htmlHeaderSets: Record<string, string>[] = []
  for (let i = 0; i < 8; i++) {
    const isDynamic = (i & 4) !== 0
    const hasIslands = (i & 2) !== 0
    const hasSuspense = (i & 1) !== 0
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', ...securityRecord }
    if (isDynamic)
      headers['cache-control'] = 'private'
    if (baseCsp !== undefined && (hasIslands || hasSuspense)) {
      headers['content-security-policy'] = withCspHashes(baseCsp, {
        styleHashes: [...(hasIslands ? [KAY_ISLAND_STYLE_HASH] : []), ...(hasSuspense ? [KAY_SUSPENSE_STYLE_HASH] : [])],
        scriptHashes: hasSuspense ? [KAY_STREAM_SCRIPT_HASH] : [],
      })
    }
    htmlHeaderSets.push(headers)
  }
  return (hasIslands, hasSuspense, isDynamic) => htmlHeaderSets[(isDynamic ? 4 : 0) | (hasIslands ? 2 : 0) | (hasSuspense ? 1 : 0)]!
}

export function resolveRenderedIslands(rctx: RenderContext, body: string): { hasIslands: boolean, eagerChunks: string[] } {
  if (rctx.hasIslands) {
    const eagerChunks: string[] = []
    for (const [chunk, eager] of rctx.renderedIslands) {
      if (eager)
        eagerChunks.push(chunk)
    }
    return { hasIslands: true, eagerChunks }
  }
  // Fallback only if raw HTML injected a <kay-island> without going through ssrIsland/ssrIslandStatic.
  if (body.includes('<kay-island'))
    return extractRenderedIslands(body)
  return { hasIslands: false, eagerChunks: [] }
}

export interface DocumentHooksOptions {
  plugins: readonly KayPlugin[]
  lang: string
  trustProxy: TrustProxy
  notifyError: (error: unknown, request: Request, source: ServerErrorInfo['source']) => void
}

export function createDocumentHooks(options: DocumentHooksOptions) {
  const { lang, trustProxy, notifyError } = options
  const headHooks = options.plugins
    .map(p => p.head)
    .filter((fn): fn is NonNullable<KayPlugin['head']> => typeof fn === 'function')
  const htmlTransformers = options.plugins
    .map(p => p.transformHtml)
    .filter((fn): fn is NonNullable<KayPlugin['transformHtml']> => typeof fn === 'function')
  const hasHeadHooks = headHooks.length > 0
  const hasHtmlTransformers = htmlTransformers.length > 0

  async function resolveDocumentHead(
    rctx: RenderContext,
    baseHeadTags: readonly string[] | undefined,
    url: URL,
    req?: Request,
    ctx?: RequestContext,
  ): Promise<{ head: string, lang: string, htmlAttrs: Record<string, string> }> {
    const collectedParts = rctx.headParts.join('')
    if (!hasHeadHooks) {
      return {
        head: (rctx.title ?? '') + collectedParts,
        lang,
        htmlAttrs: rctx.htmlAttrs,
      }
    }

    const headCtx = ctx ?? makeRequestContext(req ?? new Request(url.toString()), {}, { trustProxy, url }).ctx
    const htmlAttrs: Record<string, string> = { ...rctx.htmlAttrs }
    const initialTitleTag = rctx.title
    const initialTitleInner = initialTitleTag !== undefined ? TITLE_INNER_RE.exec(initialTitleTag)?.[1] : undefined
    let currentTitle = initialTitleInner
    let titleDirty = false
    let currentLang = htmlAttrs.lang ?? lang
    let headBuf = (initialTitleTag ?? '') + collectedParts
    if (baseHeadTags !== undefined) {
      for (let i = 0; i < baseHeadTags.length; i++)
        headBuf += baseHeadTags[i]
    }
    const added: string[] = []

    const docHead: DocumentHeadContext = {
      get lang() {
        return currentLang
      },
      set lang(v: string) {
        currentLang = v
        htmlAttrs.lang = v
      },
      htmlAttrs,
      get title() {
        return currentTitle
      },
      set title(v: string | undefined) {
        currentTitle = v
        titleDirty = true
      },
      get headHtml() {
        return headBuf
      },
      add(html: string) {
        if (html !== '') {
          added.push(html)
          headBuf += html
        }
      },
    }

    for (const hook of headHooks) {
      try {
        await hook(docHead, headCtx)
      }
      catch (err) {
        notifyError(err, req ?? headCtx.request, 'plugin')
      }
    }

    const titleHtml = titleDirty
      ? (currentTitle !== undefined ? `<title>${currentTitle}</title>` : '')
      : (initialTitleTag ?? '')
    return {
      head: titleHtml + collectedParts + (added.length > 0 ? added.join('') : ''),
      lang: currentLang,
      htmlAttrs,
    }
  }

  async function applyHtmlTransforms(html: string, url: URL, req?: Request, ctx?: RequestContext): Promise<string> {
    if (!hasHtmlTransformers)
      return html
    const transformCtx = ctx ?? makeRequestContext(req ?? new Request(url.toString()), {}, { trustProxy, url }).ctx
    let out = html
    for (const transform of htmlTransformers) {
      try {
        out = await transform(out, transformCtx)
      }
      catch (err) {
        notifyError(err, req ?? transformCtx.request, 'plugin')
      }
    }
    return out
  }

  return { hasHeadHooks, hasHtmlTransformers, htmlTransformers, resolveDocumentHead, applyHtmlTransforms }
}

export type DocumentHooks = ReturnType<typeof createDocumentHooks>
