// A request with `x-kay-region` gets that region's HTML alone: no layouts, no document, and the page's other regions never build their children.

import type { Html } from '../jsx-runtime'
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

export async function respondRegion(
  request: Request,
  mod: LoadedPageModule,
  pageProps: Record<string, unknown>,
  routePath: string,
  htmlHeaders: HtmlHeaders,
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
  const headers = { ...htmlHeaders(rctx.hasIslands, false, true), 'vary': REGION_HEADER, [REGION_HEADER]: path.join('/') }
  return new Response(html, { status: 200, headers })
}
