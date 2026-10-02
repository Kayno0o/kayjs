import type { CookieMap } from 'bun'

export interface CookieJar {
  readonly cookies: CookieMap
  // Appends a Set-Cookie header per cookie changed through `cookies`.
  writeTo: (headers: Headers) => void
}

// Parses the request's cookies only when a page or action first reads them.
export function cookieJar(request: Request): CookieJar {
  let map: CookieMap | undefined

  return {
    get cookies() {
      return map ??= new Bun.CookieMap(request.headers.get('cookie') ?? '')
    },
    writeTo(headers) {
      for (const cookie of map?.toSetCookieHeaders() ?? [])
        headers.append('set-cookie', cookie)
    },
  }
}
