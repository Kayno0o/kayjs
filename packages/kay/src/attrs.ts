// Shared HTML attribute safety & classification rules used identically by compiler, SSR, and DOM runtimes.

export const VALID_ATTR_NAME = /^[A-Za-z_:][-\w:.]*$/
export const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'data'])
const UNSAFE_URL_RE = /^(?:javascript|vbscript):/i
const SAFE_IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|ico|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i
const STRING_BOOL_ATTRS = new Set(['draggable', 'spellcheck', 'contenteditable'])

export const DOM_PROPS = new Set(['value', 'checked', 'selected', 'muted', 'indeterminate'])

export function isBlockedAttr(name: string): boolean {
  if (!VALID_ATTR_NAME.test(name))
    return true
  const lower = name.toLowerCase()
  return lower.startsWith('on') || lower === 'innerhtml' || lower === 'srcdoc'
}

export function isStringBoolAttr(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('aria-') || STRING_BOOL_ATTRS.has(lower)
}

export function isUnsafeUrlAttr(name: string, value: unknown, tag?: string): boolean {
  const lower = name.toLowerCase()
  if (!URL_ATTRS.has(lower))
    return false
  const cleaned = String(value).replace(/[\u0000-\u0020]+/g, '')
  if (UNSAFE_URL_RE.test(cleaned))
    return true
  if (!/^data:/i.test(cleaned))
    return false
  if (lower === 'src' || (lower === 'href' && tag?.toLowerCase() === 'link'))
    return !SAFE_IMAGE_DATA_URL_RE.test(cleaned)
  return true
}
