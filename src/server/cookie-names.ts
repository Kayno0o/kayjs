const HOST = '__Host-'
const SECURE = '__Secure-'

// The name a kay cookie goes out under: plain over http, over https `__Host-` for a cookie at the site's root, which no other host of the site can set, and `__Secure-` under a `base`, as `__Host-` asks for `Path=/`.
export function cookieName(name: string, secure: boolean, base = ''): string {
  return !secure ? name : `${base === '' ? HOST : SECURE}${name}`
}

// Every name `cookieName` may give `name` over https, for a cookie deleted without knowing the base it was set under.
export const prefixedNames = (name: string): string[] => [`${HOST}${name}`, `${SECURE}${name}`]
