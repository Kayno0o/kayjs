// A browser's cookies across the requests of a test: what responses set goes with the next request.
export interface CookieJar {
  cookies: Bun.CookieMap
  // The `cookie` header the jar sends to the page at `path`, `''` when it holds none; without a `path`, every cookie.
  header: (path?: string) => string
  // Sends `request` through `handle` with the cookies whose `Path` covers `path` (the URL path as the browser shows it, `base` included; the request's own without it), keeps those its response sets and drops those it expires.
  send: (handle: (request: Request) => Response | Promise<Response>, request: Request, path?: string) => Promise<Response>
}

// Whether a cookie set with `Path=<scope>` goes to the URL path `path`, as RFC 6265 matches them.
function covers(scope: string, path: string): boolean {
  return scope === '/' || path === scope || path.startsWith(scope.endsWith('/') ? scope : `${scope}/`)
}

export function cookieJar(): CookieJar {
  const cookies = new Bun.CookieMap()
  const scopes = new Map<string, string>()
  const header = (path?: string) => [...cookies].filter(([name]) => path === undefined || covers(scopes.get(name) ?? '/', path)).map(([name, value]) => `${name}=${value}`).join('; ')

  return {
    cookies,
    header,
    send: async (handle, request, path = new URL(request.url).pathname) => {
      const sent = header(path)

      if (sent !== '')
        request.headers.set('cookie', sent)

      const response = await handle(request)

      for (const line of response.headers.getSetCookie()) {
        const cookie = Bun.Cookie.parse(line)

        if (cookie.isExpired()) {
          cookies.delete(cookie.name)
          scopes.delete(cookie.name)
        }
        else {
          cookies.set(cookie)
          scopes.set(cookie.name, cookie.path)
        }
      }

      return response
    },
  }
}
