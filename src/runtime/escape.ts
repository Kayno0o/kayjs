const ESCAPE_CONTENT = /[&<]/
const ESCAPE_ATTRIBUTE = /[&"<]/
const CONTENT_ENTITIES = /[&<]/g
const ATTRIBUTE_ENTITIES = /[&"<]/g
const ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '"': '&quot;' }

const entity = (char: string) => ENTITY[char]!

export function escape(text: string): string {
  return ESCAPE_CONTENT.test(text) ? text.replace(CONTENT_ENTITIES, entity) : text
}

export function escapeAttribute(text: string): string {
  return ESCAPE_ATTRIBUTE.test(text) ? text.replace(ATTRIBUTE_ENTITIES, entity) : text
}
