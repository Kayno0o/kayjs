// Which prerendered pages Bun's route table can answer on its own, before kay sees the request.

import type { RouteManifestEntry } from '../build/index'
import type { ActionRegistry } from './action-registry'
import type { NormalizedConsentConfig } from './consent'
import type { Middleware, RequestContext } from './http'
import type { RequestKind } from './plugin-host'
import type { RequestPath } from './request-path'
import type { CompiledRoute } from './route-table'
import type { Router } from './router'
import type { TrustProxy } from './security'
import { makeRequestContext } from './http'
import { decodeRequestPath, literalPath } from './request-path'

/** The origin a page is prerendered from: the configured site's, else `http://localhost`. */
export function prerenderOrigin(site: string | undefined): string {
  if (site !== undefined && site !== '' && URL.canParse(site)) {
    const parsed = new URL(site)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      return parsed.origin
  }
  return 'http://localhost'
}

export interface NativePrerenderedDeps {
  site: string | undefined
  rewrites: readonly ((pathname: string, ctx: RequestContext) => string | undefined)[]
  pluginRouter: Pick<Router<unknown>, 'match'>
  router: Pick<Router<CompiledRoute>, 'match'>
  actions: Pick<ActionRegistry, 'byUrl'>
  middlewaresForPaths: (paths: readonly string[], kind?: RequestKind) => readonly Middleware[]
  trustProxy: TrustProxy
  consent: NormalizedConsentConfig | undefined
}

/**
 * Whether nothing would run before a prerendered page's file is served: no route or plugin middleware, no plugin route, and the same wherever the rewrites send it.
 * The build rendered the page through the rewrites on an anonymous GET, so running them once on the same GET says where they send it.
 */
export function nativePrerenderedCheck(deps: NativePrerenderedDeps): (urlPath: string, route: RouteManifestEntry) => boolean {
  const origin = prerenderOrigin(deps.site)

  function rewritten(urlPath: string): RequestPath | undefined {
    const url = new URL(urlPath, origin)
    const { ctx } = makeRequestContext(new Request(url), {}, { trustProxy: deps.trustProxy, url, consent: deps.consent })
    let path = url.pathname
    try {
      for (const rewrite of deps.rewrites)
        path = rewrite(path, ctx) ?? path
    }
    catch {
      // A rewrite that throws here throws on the request too, which reports it; the page just stays off the table.
      return undefined
    }
    return path === url.pathname ? literalPath(urlPath) : decodeRequestPath(path)
  }

  return (urlPath, route) => {
    if (route.middlewares.length > 0 || deps.pluginRouter.match(literalPath(urlPath)) !== undefined)
      return false
    const effective = deps.rewrites.length > 0 ? rewritten(urlPath) : literalPath(urlPath)
    if (effective === undefined)
      return false
    if (effective.scopedPath === urlPath)
      return deps.middlewaresForPaths([urlPath], 'prerendered').length === 0
    return deps.router.match(effective)?.data.dirMiddlewares.length === 0
      && deps.pluginRouter.match(effective) === undefined
      && (effective.staticPath === undefined || deps.actions.byUrl(effective.staticPath) === undefined)
      && deps.middlewaresForPaths([effective.scopedPath, urlPath], 'prerendered').length === 0
  }
}
