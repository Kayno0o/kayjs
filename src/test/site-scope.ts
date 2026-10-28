import type { cookieJar } from './cookies'
import type { Visit, VisitInit } from './site-types'
import { NativeHeaders } from './natives'

export const ORIGIN = 'http://localhost'

// The site's default headers, those a call gives winning by name in any case.
export function withDefaults(defaults: Record<string, string>, given: Record<string, string> | undefined, keyHeader?: string): Headers {
  const headers = new NativeHeaders(defaults)

  for (const [name, value] of Object.entries(given ?? {}))
    headers.set(name, value)

  // An empty proxy key header stands for a request that sends none.
  if (keyHeader !== undefined && headers.get(keyHeader) === '')
    headers.delete(keyHeader)

  return headers
}

// What the builders of a site's helpers share: how it sends a request and shows a path, and the connections it must close.
export interface SiteScope {
  defaults: Record<string, string>
  keyHeader: string | undefined
  base: string
  jar: ReturnType<typeof cookieJar>
  send: (path: string, init: Omit<RequestInit, 'headers'> & VisitInit) => Promise<Response>
  follow: (response: Response, url: string, headers?: Record<string, string>) => Promise<Visit>
  shown: (path: string) => string
  listening: () => Bun.Server<unknown>
  connections: Set<{ close: () => void }>
  answeredAt: WeakMap<Visit, string>
  mcpKey: string | undefined
  mcpUrl: () => string
}
