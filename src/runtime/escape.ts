const ESCAPE_CONTENT = /[&<]/
const ESCAPE_ATTRIBUTE = /[&"<]/
const CONTENT_ENTITIES = /[&<]/g
const ATTRIBUTE_ENTITIES = /[&"<]/g
const HTML_SPECIAL = /[&<>"']/g
const ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }

const entity = (char: string) => ENTITY[char]!

export function escape(text: string): string {
  return ESCAPE_CONTENT.test(text) ? text.replace(CONTENT_ENTITIES, entity) : text
}

export function escapeAttribute(text: string): string {
  return ESCAPE_ATTRIBUTE.test(text) ? text.replace(ATTRIBUTE_ENTITIES, entity) : text
}

// Text safe anywhere in markup, in content and in an attribute however it is quoted, as HTML written by hand, a mail's say, wants it.
export function escapeHtml(text: string): string {
  return text.replace(HTML_SPECIAL, entity)
}
