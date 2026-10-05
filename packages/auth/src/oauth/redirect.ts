const URL_STRIPPED = /[\t\n\r]/g
const LEADING_SPACE = /^\s+/
// Resolved against, so dot segments collapse as a browser or `new URL` would; the reserved `.invalid` names no real host.
const BASE = new URL('http://kayjs-auth.invalid')
// A path whose first segment is empty reads as a host once something decodes or resolves it again: `//evil.com`, `/%2F/evil.com`.
const SECOND_SLASH = /^\/(?:[/\\]|%2f|%5c)/i

/** True if the string holds a C0 control char or DEL - things browsers strip/normalize in URLs. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)

    if (c < 0x20 || c === 0x7F)
      return true
  }

  return false
}

/** Guards a redirect target to a same-origin absolute path (`/...`), answered normalised, else returns `fallback`; rejects protocol-relative and control-laced targets, and any that normalise to one. */
export function safeRedirect(path: string | undefined | null, fallback = '/'): string {
  if (!path)
    return fallback

  // Browsers strip tab/newline anywhere in a URL; mirror that before validating.
  const cleaned = path.replace(URL_STRIPPED, '').replace(LEADING_SPACE, '')

  if (!cleaned.startsWith('/') || cleaned.startsWith('//') || cleaned.includes('\\') || hasControlChar(cleaned))
    return fallback

  // Answered as resolved, so whatever reads it next, a Location header or the app's own `new URL(path, base)`, sees the path checked here.
  const url = new URL(cleaned, BASE)
  const normalized = `${url.pathname}${url.search}${url.hash}`

  return url.origin === BASE.origin && !SECOND_SLASH.test(normalized) ? normalized : fallback
}
