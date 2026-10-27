const WORD_BREAK = /([a-z\d])([A-Z])/g

// An export's name as a tool is named: `addNote` is `add_note`. A module of its own, so kay check reads it without the server stack.
export function snakeCase(name: string): string {
  return name.replace(WORD_BREAK, '$1_$2').toLowerCase()
}
