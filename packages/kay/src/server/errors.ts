// Errors a request runs into: the app's and plugins' `onError` hooks, and the `_error` and `_404` pages rendered outside any route.

import type { BuildManifest } from '../build/index'
import type { Html } from '../jsx-runtime'
import type { KayPlugin, ServerErrorInfo } from '../plugins/index'
import type { DocumentOptions } from '../ssr/index'
import type { CookieStore } from './cookies'
import type { DocumentHooks, HtmlHeaders } from './document'
import type { RequestContext } from './http'
import { createRenderContext, runWithRenderContext } from '../ssr/context'
import { raw, renderDocument, ssrChild } from '../ssr/index'
import { addedInlineStyleHashes, headTagStyleHashes, mergeStyleHashes, resolveRenderedIslands, revivePreload } from './document'
import { wantsJson } from './http'
import { styleHashesOf } from './security'

export type NotifyError = (error: unknown, request: Request, source: ServerErrorInfo['source']) => void

/** The text of an error a dev response shows: its stack, which starts with its message. */
export const errorDetail = (error: unknown): string => error instanceof Error ? error.stack ?? error.message : String(error)

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** What a dev server answers with an unhandled error: its message and stack, as JSON when the request wants it. */
export function devErrorResponse(error: unknown, request: Request): Response {
  if (wantsJson(request))
    return Response.json({ ok: false, status: 500, error: errorMessage(error), stack: errorDetail(error) }, { status: 500 })
  return new Response(errorDetail(error), { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

export interface ErrorNotifierOptions {
  /** With no `onError` hook to hear an unhandled error, `console.error` does. */
  dev?: boolean | undefined
  /** Hears every unhandled error, hooks or not: how `testApp().errors` fills. */
  sink?: ((info: ServerErrorInfo) => void) | undefined
}

export function createErrorNotifier(onError: ((info: ServerErrorInfo) => void) | undefined, plugins: readonly KayPlugin[], options: ErrorNotifierOptions = {}): NotifyError {
  const errorHooks: { owner: string, hook: (info: ServerErrorInfo) => void }[] = []
  if (onError !== undefined)
    errorHooks.push({ owner: 'kay.config.ts', hook: onError })
  for (const p of plugins) {
    if (p.onError !== undefined)
      errorHooks.push({ owner: p.name, hook: p.onError })
  }
  return (error, request, source) => {
    options.sink?.({ error, request, source })
    if (options.dev === true && errorHooks.length === 0)
      console.error(`kay: unhandled error in ${source} ${request.method} ${new URL(request.url).pathname}`, error)
    for (const { owner, hook } of errorHooks) {
      try {
        hook({ error, request, source })
      }
      catch (hookError) {
        console.error(`kay: the onError hook of ${owner} threw; the other hooks still run.`, hookError)
      }
    }
  }
}

interface LayoutModule {
  default: (props: { children: Html, url?: URL, params?: Record<string, string>, locals?: object }) => Html | string | Promise<Html | string>
}

interface ErrorModule {
  default: (props: { error: unknown }) => Html | string | Promise<Html | string>
}

interface NotFoundModule {
  default?: (props: Record<string, unknown>) => Html | string | Promise<Html | string>
}

export interface FallbackPagesOptions {
  manifest: BuildManifest
  modules: Record<string, unknown>
  lang: string
  alwaysLoadRuntime: boolean
  navigation?: string | undefined
  dev: boolean
  document: DocumentHooks
  htmlHeaders: HtmlHeaders
  notifyError: NotifyError
  finish: (res: Response, request: Request, cookieStore?: CookieStore) => Response
}

export function createFallbackPages(options: FallbackPagesOptions) {
  const { manifest, modules, document, htmlHeaders, notifyError, finish } = options
  const errorMod = manifest.errorFile ? modules[manifest.errorFile] as ErrorModule : undefined
  const notFoundMod = manifest.notFoundFile ? modules[manifest.notFoundFile] as NotFoundModule : undefined

  // Error and 404 pages sit outside any route, so they render with the global styles and the explicit root layout only.
  const rootLayoutFile = manifest.rootLayoutFile
  const rootLayoutMod = rootLayoutFile !== undefined ? modules[rootLayoutFile] as LayoutModule | undefined : undefined
  const fallbackDoc: DocumentOptions = {
    body: '',
    headTags: manifest.headTags,
    styles: manifest.globalStyles ?? manifest.styles,
    runtimeScript: manifest.runtimeScript,
    alwaysLoadRuntime: options.alwaysLoadRuntime,
    navigation: options.navigation,
    lang: options.lang,
  }
  const fallbackHeadStyleHashes = headTagStyleHashes(fallbackDoc.headTags)

  async function renderFallbackPage(status: number, renderInner: (() => unknown) | undefined, text: string, url?: URL, req?: Request, ctx?: RequestContext): Promise<Response> {
    if (renderInner !== undefined) {
      try {
        const effUrl = url ?? new URL(`http://localhost/${status}`)
        const rctx = createRenderContext(undefined, undefined, ctx?.consent)
        const body = await runWithRenderContext(rctx, async () => {
          let inner = ssrChild(await renderInner() as Html)
          if (rootLayoutMod !== undefined)
            inner = ssrChild(await rootLayoutMod.default({ children: raw(inner), url: effUrl, params: {}, locals: ctx?.locals ?? {} }) as Html)
          return inner
        })
        const { hasIslands, eagerChunks } = resolveRenderedIslands(rctx, body)
        const docHead = await document.resolveDocumentHead(rctx, manifest.headTags, effUrl, req, ctx)
        const docHtml = renderDocument({
          ...fallbackDoc,
          body,
          head: docHead.head,
          lang: docHead.lang,
          htmlAttrs: docHead.htmlAttrs,
          preloadChunks: [...eagerChunks, ...revivePreload(rctx, manifest.reviveScript)],
          hasIslands,
        })
        const html = await document.applyHtmlTransforms(docHtml, effUrl, req, ctx)
        const styleHashes = mergeStyleHashes(fallbackHeadStyleHashes, docHead.styleHashes, styleHashesOf(rctx.inlineStyles), addedInlineStyleHashes(docHtml, html))
        return new Response(html, { status, headers: htmlHeaders(hasIslands, false, true, styleHashes) })
      }
      catch (err) {
        if (req !== undefined)
          notifyError(err, req, 'route')
      }
    }
    return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }

  const buildErrorResponse = (error: unknown, url?: URL, req?: Request, ctx?: RequestContext): Promise<Response> =>
    renderFallbackPage(500, errorMod && (() => errorMod.default({ error })), options.dev ? errorDetail(error) : 'Internal Server Error', url, req, ctx)

  const notFoundPage = notFoundMod?.default
  const buildNotFoundResponse = (url?: URL, req?: Request, ctx?: RequestContext): Promise<Response> =>
    renderFallbackPage(404, notFoundPage && (() => notFoundPage({})), 'Not Found', url, req, ctx)

  async function renderError(error: unknown, cookieStore: CookieStore | undefined, url: URL, request: Request, ctx?: RequestContext): Promise<Response> {
    if (wantsJson(request))
      return finish(options.dev ? devErrorResponse(error, request) : Response.json({ ok: false, status: 500, error: 'Internal Server Error' }, { status: 500 }), request, cookieStore)
    return finish(await buildErrorResponse(error, url, request, ctx), request, cookieStore)
  }

  return { buildNotFoundResponse, renderError }
}
