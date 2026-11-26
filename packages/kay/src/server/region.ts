// A request with `x-kay-region` gets that region's HTML alone: no layouts, no document, and the page's other regions never build their children.

import type { RouteManifestEntry } from '../build/index'
import type { Html } from '../jsx-runtime'
import type { RenderContext } from '../ssr/context'
import type { ServedFile } from './assets'
import type { HtmlHeaders } from './document'
import type { LoadedPageModule } from './page'
import { existsSync, readFileSync } from 'node:fs'
import { getAppContext, runWithAppContext } from '../plugins/index'
import { createRenderContext, runWithRenderContext } from '../ssr/context'
import { ssrChild } from '../ssr/index'
import { finishRegion } from '../ssr/region'
import { mergeVaryValue } from './compress'
import { currentRequest, runInRequest } from './request-scope'

export const REGION_HEADER = 'x-kay-region'

export function hasRegionHeader(request: Request): boolean {
  return request.headers.has(REGION_HEADER)
}

// The header is the region's path, outermost first: `results/sets` is `sets` inside `results`.
function parseRegionPath(header: string | null): string[] | undefined {
  if (header === null)
    return undefined
  const trimmed = header.trim()
  if (trimmed === '')
    return []
  const parts = trimmed.split('/')
  if (parts.some(name => name.trim() === ''))
    return []
  return parts.map(name => name.trim())
}

export function requestedRegion(request: Request): string | undefined {
  const path = parseRegionPath(request.headers.get(REGION_HEADER))
  return path !== undefined && path.length > 0 ? path.at(-1) : undefined
}

export function invalidRegionResponse(request: Request): Response {
  return new Response(request.method === 'HEAD' ? null : 'kay: invalid x-kay-region header: pass a non-empty region name or slash-separated path.', {
    status: 400,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'vary': REGION_HEADER },
  })
}

export function withRegionVary(headers: Record<string, string>, hasRegions: boolean): Record<string, string> {
  if (!hasRegions)
    return headers
  return { ...headers, vary: mergeVaryValue(headers.vary ?? headers.Vary, REGION_HEADER) }
}

/** Stamps `Vary: x-kay-region` on prerendered routes whose HTML contains a `<Region>`. */
export function markPrerenderedRegionVary(
  routes: readonly RouteManifestEntry[],
  prerenderedMap: ReadonlyMap<string, ServedFile>,
  prerendered: Record<string, string>,
  prerenderedFiles: Record<string, string>,
): void {
  for (const route of routes) {
    if (route.prerendered === undefined || !route.usesRenderContext)
      continue
    for (const [urlPath, relHtml] of Object.entries(route.prerendered)) {
      const served = prerenderedMap.get(urlPath)
      if (served === undefined)
        continue
      let html = prerendered[relHtml]
      if (html === undefined) {
        const filePath = prerenderedFiles[relHtml]
        if (filePath !== undefined && existsSync(filePath))
          html = readFileSync(filePath, 'utf8')
      }
      if (html !== undefined && html.includes('data-kay-region="'))
        served.headers.vary = mergeVaryValue(served.headers.vary, REGION_HEADER)
    }
  }
}

const TITLE_INNER_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/i

/** Answers with the region's HTML and the page's title as it renders at this URL, in `x-kay-title` (percent-encoded), so the browser can retitle the tab without the head. */
export async function respondRegion(
  request: Request,
  mod: LoadedPageModule,
  pageProps: Record<string, unknown>,
  routePath: string,
  htmlHeaders: HtmlHeaders,
  resolveHead: (rctx: RenderContext) => Promise<{ head: string }>,
  streamTimeout?: number,
  onError?: (error: unknown) => void,
  transformHtml?: (html: string) => Promise<string>,
): Promise<Response> {
  const path = parseRegionPath(request.headers.get(REGION_HEADER))
  if (path === undefined || path.length === 0)
    return invalidRegionResponse(request)
  const name = path.at(-1)!
  const appCtx = getAppContext()
  const reqScope = currentRequest()
  const runInScope = <T>(fn: () => T): T => {
    const inner = reqScope !== undefined ? () => runInRequest(reqScope, fn) : fn
    return appCtx !== undefined ? runWithAppContext(appCtx, inner) : inner()
  }
  const rctx = createRenderContext(name, new Set(path.slice(0, -1)), reqScope?.ctx.consent)
  const html = await runWithRenderContext(rctx, async () => {
    ssrChild(await mod.default!(pageProps) as Html)
    return await finishRegion(rctx, { streamTimeout, onError, runInScope })
  })
  if (html === undefined) {
    const message = `kay: the route ${routePath} does not render <Region name="${name}">: add it to the page, or point the link's data-kay-target at a region it has.`
    return new Response(request.method === 'HEAD' ? null : message, {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'vary': REGION_HEADER },
    })
  }
  const outHtml = request.method === 'HEAD' ? null : (transformHtml !== undefined ? await transformHtml(html) : html)
  const title = TITLE_INNER_RE.exec((await resolveHead(rctx)).head)?.[1]
  const headers: Record<string, string> = { ...htmlHeaders(rctx.hasIslands, false, true), 'vary': REGION_HEADER, [REGION_HEADER]: path.join('/') }
  if (title !== undefined)
    headers['x-kay-title'] = encodeURIComponent(title)
  return new Response(outHtml, { status: 200, headers })
}
