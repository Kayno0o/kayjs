const URL_STRIPPED = /[\t\n\r]/g
const LEADING_SPACE = /^\s+/
// A `%XX` of the ASCII range, which a lenient decoder turns into its character even beside a malformed escape.
const ASCII_ESCAPE = /%([0-7][\da-f])/gi
const MAX_LAYERS = 8
// Resolved against, so dot segments collapse as a browser or `new URL` would; the reserved `.invalid` names no real host.
const BASE = new URL('http://kayjs-auth.invalid')
// A path whose first segment is empty, or decodes to empty, reads as a host once something decodes or resolves it again: `//evil.com`, `/%2F/evil.com`.
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
  const cleaned = stripped(path)

  if (!cleaned.startsWith('/') || cleaned.startsWith('//') || cleaned.includes('\\') || hasControlChar(cleaned))
    return fallback

  // Answered as resolved, so whatever reads it next, a Location header or the app's own `new URL(path, base)`, sees the path checked here.
  const normalized = resolved(cleaned)
  // Checked decoded once too, for an app that decodes before it resolves: `/.%2f/evil.com` is `//evil.com` to it.
  const decoded = decodedOnce(normalized)

  return SECOND_SLASH.test(normalized) || decoded === undefined || leavesSite(decoded) ? fallback : normalized
}

// What an app that decoded the path sees: the tab and newline a browser strips only after decoding (`/%09/evil.com`) can leave a second slash or a backslash up front, and resolving alone would hide it behind the other host's pathname.
// Each further layer of encoding (`/%2509/evil.com`) is checked too, decoded leniently as `unescape` would, until decoding changes nothing; a path still decoding past `MAX_LAYERS` is no real redirect.
function leavesSite(decoded: string): boolean {
  let current = decoded

  for (let layer = 0; layer <= MAX_LAYERS; layer++) {
    const cleaned = stripped(current)

    if (!cleaned.startsWith('/') || SECOND_SLASH.test(cleaned) || new URL(cleaned, BASE).origin !== BASE.origin || SECOND_SLASH.test(resolved(cleaned)))
      return true

    const next = cleaned.replace(ASCII_ESCAPE, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

    if (next === cleaned)
      return false

    current = next
  }

  return true
}

function stripped(s: string): string {
  return s.replace(URL_STRIPPED, '').replace(LEADING_SPACE, '')
}

// Starting with a single slash and holding no backslash, the path stays on `BASE`'s origin.
function resolved(path: string): string {
  const url = new URL(path, BASE)

  return `${url.pathname}${url.search}${url.hash}`
}

// Undefined for a malformed escape in the path, which no app could decode either; the query and hash can't move the path, so a bare `%` there stays as written.
function decodedOnce(path: string): string | undefined {
  const end = path.search(/[?#]/)
  const split = end === -1 ? path.length : end

  try {
    return decodeURIComponent(path.slice(0, split)) + path.slice(split)
  }
  catch {
    return undefined
  }
}
