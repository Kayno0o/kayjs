// A request with `x-kay-region` gets that region's HTML alone: no layouts, no document, and the page's other regions never build their children.

import type { Html } from '../jsx-runtime'
import type { HtmlHeaders } from './document'
import type { LoadedPageModule } from './page'
import { createRenderContext, runWithRenderContext } from '../ssr/context'
import { finishRegion } from '../ssr/region'
import { ssrChild } from '../ssr/index'

export const REGION_HEADER = 'x-kay-region'

export function requestedRegion(request: Request): string | undefined {
  const name = request.headers.get(REGION_HEADER)
  return name === null || name === '' ? undefined : name
}

export async function respondRegion(
  name: string,
  mod: LoadedPageModule,
  pageProps: Record<string, unknown>,
  routePath: string,
  htmlHeaders: HtmlHeaders,
): Promise<Response> {
  const rctx = createRenderContext(name)
  const html = await runWithRenderContext(rctx, async () => {
    ssrChild(await mod.default!(pageProps) as Html)
    return await finishRegion(rctx)
  })
  if (html === undefined)
    throw new Error(`kay: the route ${routePath} does not render <Region name="${name}">: add it to the page, or point the link's data-kay-target at a region it has.`)
  const headers = { ...htmlHeaders(rctx.hasIslands, false, true), 'vary': REGION_HEADER, [REGION_HEADER]: name }
  return new Response(html, { status: 200, headers })
}
