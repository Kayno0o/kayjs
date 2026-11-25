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
import { resolveRenderedIslands } from './document'
import { wantsJson } from './http'

export type NotifyError = (error: unknown, request: Request, source: ServerErrorInfo['source']) => void

export function createErrorNotifier(onError: ((info: ServerErrorInfo) => void) | undefined, plugins: readonly KayPlugin[]): NotifyError {
  const errorHooks: ((info: ServerErrorInfo) => void)[] = []
  if (onError !== undefined)
    errorHooks.push(onError)
  for (const p of plugins) {
    if (p.onError !== undefined)
      errorHooks.push(p.onError)
  }
  return (error, request, source) => {
    for (const hook of errorHooks) {
      try {
        hook({ error, request, source })
      }
      catch {}
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
    lang: options.lang,
  }

  async function renderFallbackPage(status: number, renderInner: (() => unknown) | undefined, text: string, url?: URL, req?: Request, ctx?: RequestContext): Promise<Response> {
    if (renderInner !== undefined) {
      try {
        const effUrl = url ?? new URL(`http://localhost/${status}`)
        const rctx = createRenderContext()
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
          preloadChunks: eagerChunks,
          hasIslands,
        })
        const html = await document.applyHtmlTransforms(docHtml, effUrl, req, ctx)
        return new Response(html, { status, headers: htmlHeaders(hasIslands, false, true) })
      }
      catch (err) {
        if (req !== undefined)
          notifyError(err, req, 'route')
      }
    }
    return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }

  const buildErrorResponse = (error: unknown, url?: URL, req?: Request, ctx?: RequestContext): Promise<Response> =>
    renderFallbackPage(500, errorMod && (() => errorMod.default({ error })), 'Internal Server Error', url, req, ctx)

  const notFoundPage = notFoundMod?.default
  const buildNotFoundResponse = (url?: URL, req?: Request, ctx?: RequestContext): Promise<Response> =>
    renderFallbackPage(404, notFoundPage && (() => notFoundPage({})), 'Not Found', url, req, ctx)

  async function renderError(error: unknown, cookieStore: CookieStore | undefined, url: URL, request: Request, ctx?: RequestContext): Promise<Response> {
    if (wantsJson(request))
      return finish(Response.json({ ok: false, status: 500, error: 'Internal Server Error' }, { status: 500 }), request, cookieStore)
    return finish(await buildErrorResponse(error, url, request, ctx), request, cookieStore)
  }

  return { buildNotFoundResponse, renderError }
}
