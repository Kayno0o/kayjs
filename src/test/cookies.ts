// A browser's cookies across the requests of a test: what responses set goes with the next request.
export interface CookieJar {
  cookies: Bun.CookieMap
  // The `cookie` header the jar sends to the page at `path`, `''` when it holds none; without a `path`, every cookie.
  header: (path?: string) => string
  // Keeps the cookies a response sets and drops those it expires, for one that did not go through `send`.
  // A cookie set with no `Path` is for the directory of `from`, the URL path the response answers (RFC 6265 5.1.4), the root without it.
  keep: (response: Response, from?: string) => void
  // Sends `request` through `handle` with the cookies whose `Path` covers `path` (the URL path as the browser shows it, `base` included; the request's own without it), keeps those its response sets and drops those it expires.
  send: (handle: (request: Request) => Response | Promise<Response>, request: Request, path?: string) => Promise<Response>
}

// Whether a cookie set with `Path=<scope>` goes to the URL path `path`, as RFC 6265 matches them.
function covers(scope: string, path: string): boolean {
  return scope === '/' || path === scope || path.startsWith(scope.endsWith('/') ? scope : `${scope}/`)
}

const PATH_ATTRIBUTE = /;\s*path\s*=\s*\//i
const cookieName = (piece: string): string => piece.slice(0, Math.max(piece.indexOf('='), 0)).trim()

// A request's own `cookie` header with the jar's cookies it does not name itself.
export function withKept(given: string | null, kept: string): string {
  const named = new Set((given ?? '').split(';').map(cookieName))

  return [...given === null || given === '' ? [] : [given], ...kept.split('; ').filter(piece => piece !== '' && !named.has(cookieName(piece)))].join('; ')
}

export function cookieJar(): CookieJar {
  const cookies = new Bun.CookieMap()
  // What responses set, identified as a browser does: by name, domain and path (RFC 6265 5.3). `cookies` shows the latest of each name; a value a test wrote there itself differs from what was mirrored and is sent for every path.
  const stored = new Map<string, { name: string, value: string, path: string }>()
  const mirrored = new Map<string, string>()
  const mirror = (name: string) => {
    const latest = [...stored.values()].findLast(cookie => cookie.name === name)

    if (latest) {
      cookies.set(name, latest.value)
      mirrored.set(name, latest.value)
    }
    else {
      cookies.delete(name)
      mirrored.delete(name)
    }
  }

  const header = (path?: string) => {
    const pieces: string[] = []

    for (const [name, value] of cookies) {
      const own = mirrored.get(name) === value ? [...stored.values()].filter(cookie => cookie.name === name) : []

      if (own.length === 0)
        pieces.push(`${name}=${value}`)
      else
        pieces.push(...own.filter(cookie => path === undefined || covers(cookie.path, path)).map(cookie => `${name}=${cookie.value}`))
    }

    return pieces.join('; ')
  }

  const keep = (response: Response, from = '/') => {
    for (const line of response.headers.getSetCookie()) {
      const cookie = Bun.Cookie.parse(line)
      // Bun answers `/` for a missing `Path`, as for an explicit one.
      const path = PATH_ATTRIBUTE.test(line) ? cookie.path : from.slice(0, from.lastIndexOf('/')) || '/'
      const key = `${cookie.domain ?? ''}\0${path}\0${cookie.name}`

      if (cookie.isExpired())
        stored.delete(key)
      else
        stored.set(key, { name: cookie.name, value: cookie.value, path })

      mirror(cookie.name)
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

      keep(response, path)

      return response
    },
  }
}
