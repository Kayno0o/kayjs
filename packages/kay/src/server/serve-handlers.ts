// The handlers `Bun.serve()` runs for an app: its native route table of files and fast pages, its fetch fallback and its error answer. `serve()` starts a server with them, `reloadInto()` swaps them into one already listening.

import type { createAssets, ServedFile } from './assets'
import type { NotifyError } from './errors'
import type { KayServer } from './http'
import type { RequestPath } from './request-path'
import type { FastHandler } from './routing'
import { ACTION_ERROR_COOKIE } from './action'
import { hasRegionHeader } from './region'
import { literalPath } from './request-path'
import { toBunRouteKey } from './routing'

export interface ServeHandlerSources {
  files: ReturnType<typeof createAssets>
  fastPrerenderedMap: ReadonlyMap<string, ServedFile>
  fastStaticPages: ReadonlyMap<string, FastHandler>
  pluginRouter: { match: (path: RequestPath) => unknown }
  /** Answers through the app's whole pipeline, with the request's timeout turned off by `disableTimeout` for a long-lived stream. */
  runRequest: (req: Request, remoteIp: string | undefined, disableTimeout: () => void) => Promise<Response>
  runFast: (handler: FastHandler, req: Request, remoteIp: string | undefined) => Response | Promise<Response>
  notifyError: NotifyError
  serverError: () => Response
  fileGone: () => Response
}

export const isRead = (request: Request): boolean => request.method === 'GET' || request.method === 'HEAD'

export const hasActionErrorCookie = (request: Request): boolean => (request.headers.get('cookie') ?? '').includes(`${ACTION_ERROR_COOKIE}=`)

// A read the pre-rendered and fast static paths may answer: nothing to flash back to the page, and not a partial <Region> request.
export const isPlainRead = (request: Request): boolean => isRead(request) && !hasActionErrorCookie(request) && !hasRegionHeader(request)

export function serveHandlers(server: () => KayServer | undefined, sources: ServeHandlerSources) {
  const { files, fastPrerenderedMap, fastStaticPages, pluginRouter, runRequest, runFast, notifyError, serverError, fileGone } = sources
  const ipOf = (req: Request) => server()?.requestIP(req)?.address
  const fetchReq = (req: Request) => runRequest(req, ipOf(req), () => server()?.timeout(req, 0))

  const routes: Record<string, (req: Request) => Response | Promise<Response>> = {}
  const registerServeRoute = (path: string, handler: (req: Request) => Response | Promise<Response>): void => {
    const key = toBunRouteKey(path)
    if (key !== undefined && !(key in routes))
      routes[key] = handler
  }

  for (const [path, asset] of files.assetMap)
    registerServeRoute(path, req => isRead(req) ? files.serveFile(req, asset) : fetchReq(req))

  for (const [path, pub] of files.publicMap) {
    if (pluginRouter.match(literalPath(path)) === undefined)
      registerServeRoute(path, req => isRead(req) ? files.serveFile(req, pub) : fetchReq(req))
  }

  for (const [path, pre] of fastPrerenderedMap)
    registerServeRoute(path, req => isPlainRead(req) ? files.serveFile(req, pre) : fetchReq(req))

  for (const [path, handler] of fastStaticPages)
    registerServeRoute(path, req => isPlainRead(req) ? runFast(handler, req, ipOf(req)) : fetchReq(req))

  return {
    routes,
    fetch: fetchReq,
    error(err: Error) {
      if ('code' in err && err.code === 'ENOENT')
        return fileGone()
      notifyError(err, new Request('http://localhost/'), 'route')
      return serverError()
    },
  }
}
