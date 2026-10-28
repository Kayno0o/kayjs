import type { SiteScope } from './site-scope'
import type { ApiResult, TestSite } from './site-types'
import { callBody, readAnswer, routeUrl } from '../runtime/live'
import { NativeHeaders, withNatives } from './natives'

export function apiOf({ defaults, send }: SiteScope): Pick<TestSite, 'api'> {
  return {
    api: async (module, path, ...[options]) => withNatives(async () => {
      const { method = 'get', body, headers } = (options ?? {}) as { method?: string, body?: unknown, headers?: Record<string, string> }
      const sent = callBody(body)
      // JSON unless the site or the call asks for another type.
      const implicitAccept: Record<string, string> = new NativeHeaders(defaults).has('accept') ? {} : { accept: 'application/json' }
      const response = await send(routeUrl(module, path, options as Parameters<typeof routeUrl>[2]), { method: method.toUpperCase(), headers: { ...implicitAccept, ...sent.headers, ...headers }, body: sent.body ?? null })

      return { ok: response.ok, status: response.status, headers: response.headers, body: await readAnswer(response) } as ApiResult<never>
    }),
  }
}
