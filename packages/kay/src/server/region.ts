// A request with `x-kay-region` gets that region's HTML alone: no layouts, no document, and the page's other regions never build their children.

import type { Html } from '../jsx-runtime'
import type { RenderContext } from '../ssr/context'
import type { HtmlHeaders } from './document'
import type { LoadedPageModule } from './page'
import { createRenderContext, runWithRenderContext } from '../ssr/context'
import { finishRegion } from '../ssr/region'
import { ssrChild } from '../ssr/index'

export const REGION_HEADER = 'x-kay-region'

// The header is the region's path, outermost first: `results/sets` is `sets` inside `results`.
function regionPath(request: Request): string[] {
  const path = request.headers.get(REGION_HEADER)
  return path === null ? [] : path.split('/').filter(name => name !== '')
}

export function requestedRegion(request: Request): string | undefined {
  return regionPath(request).at(-1)
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
): Promise<Response> {
  const path = regionPath(request)
  const name = path.at(-1)!
  const rctx = createRenderContext(name, new Set(path.slice(0, -1)))
  const html = await runWithRenderContext(rctx, async () => {
    ssrChild(await mod.default!(pageProps) as Html)
    return await finishRegion(rctx)
  })
  if (html === undefined)
    throw new Error(`kay: the route ${routePath} does not render <Region name="${name}">: add it to the page, or point the link's data-kay-target at a region it has.`)
  const title = TITLE_INNER_RE.exec((await resolveHead(rctx)).head)?.[1]
  const headers: Record<string, string> = { ...htmlHeaders(rctx.hasIslands, false, true), 'vary': REGION_HEADER, [REGION_HEADER]: path.join('/') }
  if (title !== undefined)
    headers['x-kay-title'] = encodeURIComponent(title)
  return new Response(html, { status: 200, headers })
}
