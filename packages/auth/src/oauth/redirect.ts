/** True if the string holds a C0 control char or DEL - things browsers strip/normalize in URLs. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)

    if (c < 0x20 || c === 0x7F)
      return true
  }

  return false
}

/** Guards a redirect target to a same-origin absolute path (`/...`), else returns `fallback`; rejects protocol-relative and control-laced targets. */
export function safeRedirect(path: string | undefined | null, fallback = '/'): string {
  if (!path)
    return fallback

  // Browsers strip tab/newline anywhere in a URL; mirror that before validating.
  const cleaned = path.replace(/[\t\n\r]/g, '').replace(/^\s+/, '')

  if (cleaned.startsWith('/') && !cleaned.startsWith('//') && !cleaned.includes('\\') && !hasControlChar(cleaned))
    return cleaned

  return fallback
}
