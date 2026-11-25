// Shared HTML attribute safety & classification rules used identically by compiler, SSR, and DOM runtimes.

export const VALID_ATTR_NAME = /^[A-Za-z_:][-\w:.]*$/
export const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'data'])
const UNSAFE_URL_RE = /^(?:javascript|vbscript):/i
const UNSAFE_DATA_URL_RE = /^data:(?!image\/(?:png|jpe?g|gif|webp|avif|bmp|ico);)/i
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

export function isUnsafeUrlAttr(name: string, value: unknown): boolean {
  const lower = name.toLowerCase()
  if (!URL_ATTRS.has(lower))
    return false
  const cleaned = String(value).replace(/[\u0000-\u0020]+/g, '')
  if (UNSAFE_URL_RE.test(cleaned))
    return true
  if (lower !== 'src' && /^data:/i.test(cleaned))
    return true
  if (lower === 'src' && UNSAFE_DATA_URL_RE.test(cleaned))
    return true
  return false
}
