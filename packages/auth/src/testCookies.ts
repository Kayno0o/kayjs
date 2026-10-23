// The session cookie names `signInAs` set in a test site's jar, dropped with the default ones when the site signs out or in again.
export const signedInCookies = new WeakMap<Bun.CookieMap, string[]>()

export function dropSession(cookies: Bun.CookieMap): void {
  for (const name of new Set(['kay_session', '__Host-kay_session', ...signedInCookies.get(cookies) ?? []]))
    cookies.delete(name)

  signedInCookies.delete(cookies)
}
