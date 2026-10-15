// A browser's cookies across the requests of a test: what responses set goes with the next request.
export interface CookieJar {
  cookies: Bun.CookieMap
  // The `cookie` header the jar sends, `''` when it holds none.
  header: () => string
  // Sends `request` through `handle` with the jar's cookies, keeps those its response sets and drops those it expires.
  send: (handle: (request: Request) => Response | Promise<Response>, request: Request) => Promise<Response>
}

export function cookieJar(): CookieJar {
  const cookies = new Bun.CookieMap()
  const header = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')

  return {
    cookies,
    header,
    send: async (handle, request) => {
      const sent = header()

      if (sent !== '')
        request.headers.set('cookie', sent)

      const response = await handle(request)

      for (const line of response.headers.getSetCookie()) {
        const cookie = Bun.Cookie.parse(line)

        if (cookie.isExpired())
          cookies.delete(cookie.name)
        else
          cookies.set(cookie)
      }

      return response
    },
  }
}
