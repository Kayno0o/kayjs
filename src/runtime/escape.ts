const ESCAPE_CONTENT = /[&<]/
const ESCAPE_ATTRIBUTE = /[&"<]/
const ESCAPE_SINGLE_QUOTED = /[&'<]/
const CONTENT_ENTITIES = /[&<]/g
const ATTRIBUTE_ENTITIES = /[&"<]/g
const SINGLE_QUOTED_ENTITIES = /[&'<]/g
const ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '"': '&quot;', '\'': '&#39;' }

const entity = (char: string) => ENTITY[char]!

export function escape(text: string): string {
  return ESCAPE_CONTENT.test(text) ? text.replace(CONTENT_ENTITIES, entity) : text
}

export function escapeAttribute(text: string): string {
  return ESCAPE_ATTRIBUTE.test(text) ? text.replace(ATTRIBUTE_ENTITIES, entity) : text
}

function occurrences(text: string, char: string): number {
  let count = 0

  for (let at = text.indexOf(char); at !== -1; at = text.indexOf(char, at + 1))
    count++

  return count
}

// The value with its quotes, single ones when it holds more double quotes than single, as JSON does, so each of them costs one byte rather than six.
export function quoteAttribute(text: string): string {
  if (!text.includes('"') || (text.includes('\'') && occurrences(text, '\'') >= occurrences(text, '"')))
    return `"${escapeAttribute(text)}"`

  return `'${ESCAPE_SINGLE_QUOTED.test(text) ? text.replace(SINGLE_QUOTED_ENTITIES, entity) : text}'`
}
