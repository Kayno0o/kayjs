// A browser's cookies across the requests of a test: what responses set goes with the next request.
export interface CookieJar {
  cookies: Bun.CookieMap
  // The `cookie` header the jar sends to the page at `path`, `''` when it holds none; without a `path`, every cookie.
  header: (path?: string) => string
  // Keeps the cookies a response sets and drops those it expires, for one that did not go through `send`.
  keep: (response: Response) => void
  // Sends `request` through `handle` with the cookies whose `Path` covers `path` (the URL path as the browser shows it, `base` included; the request's own without it), keeps those its response sets and drops those it expires.
  send: (handle: (request: Request) => Response | Promise<Response>, request: Request, path?: string) => Promise<Response>
}

// Whether a cookie set with `Path=<scope>` goes to the URL path `path`, as RFC 6265 matches them.
function covers(scope: string, path: string): boolean {
  return scope === '/' || path === scope || path.startsWith(scope.endsWith('/') ? scope : `${scope}/`)
}

const cookieName = (piece: string): string => piece.slice(0, Math.max(piece.indexOf('='), 0)).trim()

// A request's own `cookie` header with the jar's cookies it does not name itself.
export function withKept(given: string | null, kept: string): string {
  const named = new Set((given ?? '').split(';').map(cookieName))

  return [...given === null || given === '' ? [] : [given], ...kept.split('; ').filter(piece => piece !== '' && !named.has(cookieName(piece)))].join('; ')
}

export function cookieJar(): CookieJar {
  const cookies = new Bun.CookieMap()
  const scopes = new Map<string, string>()
  const header = (path?: string) => [...cookies].filter(([name]) => path === undefined || covers(scopes.get(name) ?? '/', path)).map(([name, value]) => `${name}=${value}`).join('; ')

  const keep = (response: Response) => {
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
  }

  return {
    cookies,
    header,
    keep,
    send: async (handle, request, path = new URL(request.url).pathname) => {
      const sent = withKept(request.headers.get('cookie'), header(path))

      if (sent !== '')
        request.headers.set('cookie', sent)

      const response = await handle(request)

      keep(response)

      return response
    },
  }
}
