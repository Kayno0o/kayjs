// The `error` option of a rule: `min` for a text too short, a list too short or a number too small, `max` for the other bound, else the kind itself (`pattern`, `format`, `required`, `type`).
const RULES: Record<string, string> = { tooShort: 'min', tooFewItems: 'min', tooSmall: 'min', tooLong: 'max', tooManyItems: 'max', tooBig: 'max' }

export function ruleOf(kind: string): string {
  return RULES[kind] ?? kind
}

// The text an `error` option gives a field: a string, the string a function returns, or for a record the entry of the rule the field failed, else its `default`; a function that throws or returns anything else gives none, so the field keeps its default wording.
// A function is called where the caller runs, which is inside the request's locale.
export function errorText(error: unknown, rule?: string): string | undefined {
  if (typeof error === 'function') {
    try {
      const text = (error as () => unknown)()

      return typeof text === 'string' ? text : undefined
    }
    catch {
      return undefined
    }
  }

  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const words = error as Record<string, unknown>

    return errorText((rule === undefined ? undefined : words[rule]) ?? words.default)
  }

  return typeof error === 'string' ? error : undefined
}

const isNode = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// The first `error` found on the way down: a field's own, else a branch of its `anyOf`.
function find(node: unknown, segments: string[], rule: string | undefined): string | undefined {
  if (!isNode(node))
    return undefined

  const [head, ...rest] = segments
  const named = head !== undefined && isNode(node.properties) && Object.hasOwn(node.properties, head)
  const found = head === undefined ? errorText(node.error, rule) : find(named ? (node.properties as Record<string, unknown>)[head] : node.items, rest, rule)

  if (found !== undefined || !Array.isArray(node.anyOf))
    return found

  for (const branch of node.anyOf) {
    const inBranch = find(branch, segments, rule)

    if (inBranch !== undefined)
      return inBranch
  }

  return undefined
}

// The `error` option at a JSON pointer of the schema, a field's, an item's or one of a union's branches, read in the current locale.
export function fieldMessage(schema: unknown, pointer: string, rule?: string): string | undefined {
  return find(schema, pointer.split('/').slice(1).map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~')), rule)
}
