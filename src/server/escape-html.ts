const HTML_SPECIAL = /[&<>"']/g
const ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }

// Text safe anywhere in markup, in content and in an attribute however it is quoted, as HTML written by hand, a mail's say, wants it.
export function escapeHtml(text: string): string {
  return text.replace(HTML_SPECIAL, char => ENTITY[char]!)
}
