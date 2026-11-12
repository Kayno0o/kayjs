import type { Details, Fix, NamedAttribute } from './ast'

const PART = '[A-Z][\\w-]*'

export const PART_NAME = new RegExp(`^${PART}$`, 'i')
export const PART_NAME_LIST = new RegExp(`^${PART}(?: ${PART})*$`, 'i')
export const FIELD_NAME = /^[\w.[\]-]+$/
const WHITESPACE_CHAR = /\s/
const COMMA_AFTER = /^\s*,\s*/
// The text of a static attribute that a fix moves as it is: no quote, escape, entity or line break.
const PLAIN_TEXT = /^[^"'`\\&\n{}<>]*$/
// A string expression with nothing to interpolate or escape.
const QUOTED = /^\s*(['"`])([^'"`\\${}\n]*)\1\s*$/

// The quick fixes of the template errors that have one right answer, each reading the source the offsets index into.
export class AttributeFixes {
  constructor(private readonly src: string) {}

  // The attribute whole, from its name to its closing quote or brace, and the blank before it, so deleting it leaves the others as they were.
  removal(title: string, attribute: Extract<NamedAttribute, { kind: 'static' | 'boolean' }>): Fix {
    let end = attribute.kind === 'static' ? attribute.value.end + 1 : attribute.name.end
    let start = attribute.name.start

    while (start > 0 && WHITESPACE_CHAR.test(this.src[start - 1]!))
      start--

    // In a comma-separated list the comma goes with it: the one before, else the one after.
    if (this.src[start - 1] === ',') {
      start--
    }
    else {
      const after = COMMA_AFTER.exec(this.src.slice(end))

      if (after)
        end += after[0].length
    }

    return { title, safe: true, edits: [{ start, end, text: '' }] }
  }

  // Two static `class` attributes become one holding both, the second written no more.
  mergedClasses(first: NamedAttribute, second: NamedAttribute): Pick<Details, 'fixes'> {
    if (first.kind !== 'static' || second.kind !== 'static' || [first, second].some(attribute => !PLAIN_TEXT.test(this.text(attribute.value))))
      return {}

    const classes = `${this.text(first.value).trim()} ${this.text(second.value).trim()}`.trim()

    return { fixes: [{ title: 'Merge the two `class` attributes', safe: true, edits: [{ ...first.value, text: classes }, ...this.removal('', second).edits] }] }
  }

  // An attribute that takes written text, given as a string expression, `part={'head'}`: written as `part="head"`.
  writtenText(attribute: NamedAttribute, name: string, valid: RegExp): Pick<Details, 'fixes'> {
    if (attribute.kind !== 'expression' || attribute.shorthand)
      return {}

    const text = QUOTED.exec(this.text(attribute.expression))?.[2]

    return text === undefined || !valid.test(text) ? {} : { fixes: [{ title: `Write \`${name}="${text}"\``, safe: true, edits: [{ start: attribute.name.start, end: attribute.expression.end + 1, text: `${name}="${text}"` }] }] }
  }

  // A static `style:color="red"` is the expression `{"red"}`.
  asExpression(attribute: NamedAttribute): Pick<Details, 'fixes'> {
    if (attribute.kind !== 'static' || !PLAIN_TEXT.test(this.text(attribute.value)))
      return {}

    const written = JSON.stringify(this.text(attribute.value))

    return { fixes: [{ title: `Write \`{${written}}\``, safe: true, edits: [{ start: attribute.value.start - 1, end: attribute.value.end + 1, text: `{${written}}` }] }] }
  }

  private text(span: { start: number, end: number }): string {
    return this.src.slice(span.start, span.end)
  }
}
