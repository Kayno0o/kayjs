// What a route file is to the server: the page, layout and middleware modules it loads, and the answers derived from their exports.

import type { BuildManifest, RouteManifestEntry } from '../build/index'
import type { Html } from '../jsx-runtime'
import type { Middleware, RequestContext } from './http'
import type { KayLocals } from './index'

export interface LoadedPageModule {
  default?: (props: Record<string, unknown>) => Html | string | Promise<Html | string>
  load?: (ctx: RequestContext) => unknown | Promise<unknown>
  clientData?: readonly string[] | ((data: unknown) => unknown) | undefined
  csrf?: boolean | undefined
  GET?: (ctx: RequestContext) => Response | Promise<Response>
  POST?: (ctx: RequestContext) => Response | Promise<Response>
  PUT?: (ctx: RequestContext) => Response | Promise<Response>
  PATCH?: (ctx: RequestContext) => Response | Promise<Response>
  DELETE?: (ctx: RequestContext) => Response | Promise<Response>
  HEAD?: (ctx: RequestContext) => Response | Promise<Response>
  OPTIONS?: (ctx: RequestContext) => Response | Promise<Response>
  [key: string]: unknown
}

export interface LoadedLayoutModule {
  default: (props: { children: Html, url?: URL, params?: Record<string, string>, locals?: KayLocals }) => Html | string | Promise<Html | string>
}

export interface LoadedMiddlewareModule {
  default: Middleware
}

const HTTP_METHOD_EXPORTS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

export function mergedHeadTags(manifest: BuildManifest, entry: RouteManifestEntry): string[] | undefined {
  return entry.headTags !== undefined && entry.headTags.length > 0
    ? [...(manifest.headTags ?? []), ...entry.headTags]
    : manifest.headTags
}

export function allowedMethodsHeader(mod: LoadedPageModule): string {
  const allowed = new Set<string>()
  if (typeof mod.default === 'function') {
    allowed.add('GET')
    allowed.add('HEAD')
  }
  for (const m of HTTP_METHOD_EXPORTS) {
    if (typeof mod[m] === 'function')
      allowed.add(m)
  }
  if (allowed.has('GET'))
    allowed.add('HEAD')
  return [...allowed].join(', ')
}

async function cancelBodyQuietly(body: ReadableStream<Uint8Array>): Promise<void> {
  try {
    await body.cancel()
  }
  catch {}
}

export function stripHeadBody(res: Response): Response {
  if (res.body !== null)
    void cancelBodyQuietly(res.body)
  return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers })
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pickObjectKeys(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | undefined {
  if (keys.length === 0)
    return undefined
  const picked: Record<string, unknown> = {}
  let count = 0
  for (const k of keys) {
    if (Object.hasOwn(obj, k)) {
      Object.defineProperty(picked, k, { value: obj[k], enumerable: true, writable: true, configurable: true })
      count++
    }
  }
  return count > 0 ? picked : undefined
}

export function pickPageIslandProps(data: unknown, entry: RouteManifestEntry, mod: LoadedPageModule): Record<string, unknown> {
  if (data === undefined)
    return {}
  if (typeof mod.clientData === 'function') {
    const subset = mod.clientData(data)
    return subset === undefined ? {} : { data: subset }
  }
  if (Array.isArray(mod.clientData)) {
    if (!isPlainObject(data))
      return {}
    const subset = pickObjectKeys(data, mod.clientData)
    return subset === undefined ? {} : { data: subset }
  }
  if (entry.islandDataKeys !== undefined) {
    if (entry.islandDataKeys.length === 0)
      return {}
    if (isPlainObject(data)) {
      const subset = pickObjectKeys(data, entry.islandDataKeys)
      return subset === undefined ? {} : { data: subset }
    }
  }
  return { data }
}
