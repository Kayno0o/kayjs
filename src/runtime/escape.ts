const ESCAPE_TEXT = /[&<>"]/g
const ESCAPE_HTML = /[&<>"']/g
const ESCAPE_CONTENT = /[&<]/
const ESCAPE_ATTRIBUTE = /[&"<]/
const ESCAPE_SINGLE_QUOTED = /[&'<]/
const CONTENT_ENTITIES = /[&<]/g
const ATTRIBUTE_ENTITIES = /[&"<]/g
const SINGLE_QUOTED_ENTITIES = /[&'<]/g
const ENTITY: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }

const entity = (char: string) => ENTITY[char]!

export function escape(text: string): string {
  return ESCAPE_CONTENT.test(text) ? text.replace(CONTENT_ENTITIES, entity) : text
}

// Text safe anywhere in markup, in content and in an attribute however it is quoted, as HTML written by hand, a mail's say, wants it.
// kept: free
export function escapeHtml(text: string): string {
  return text.replace(ESCAPE_HTML, entity)
}

// Escaped as Bun.markdown escapes the text it renders, which leaves `'` as it is: what the browser's Markdown must write to read as the server's.
export function escapeMarkdownText(text: string): string {
  return text.replace(ESCAPE_TEXT, entity)
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

// The value with its quotes: single ones when it holds more double quotes than single, as serialized JSON does, so each costs one byte rather than six; double ones on a tie.
export function quotedAttribute(text: string): string {
  if (!text.includes('"') || (text.includes('\'') && occurrences(text, '\'') >= occurrences(text, '"')))
    return `"${escapeAttribute(text)}"`

  return `'${ESCAPE_SINGLE_QUOTED.test(text) ? text.replace(SINGLE_QUOTED_ENTITIES, entity) : text}'`
}
