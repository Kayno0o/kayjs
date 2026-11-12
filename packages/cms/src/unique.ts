import type { Issue, JsonSchema } from './kay/contract'
import { fieldsOf } from './fields'

// The top-level fields declared `unique`, those of an `Intersect`'s members as well.
function uniqueKeys(schema: JsonSchema): string[] {
  const { properties = {}, allOf = [] } = schema as { properties?: Record<string, { 'x-kay-unique'?: boolean }>, allOf?: JsonSchema[] }

  return [...new Set([...Object.keys(properties).filter(key => properties[key]!['x-kay-unique'] === true), ...allOf.flatMap(uniqueKeys)])]
}

// The refusal with each issue's message led by its field, as the toast shows the messages alone.
export function namingFields<Outcome extends { issues: Issue[] }>(outcome: Outcome): Outcome {
  return { ...outcome, issues: outcome.issues.map(issue => issue.path === '' ? issue : { ...issue, message: `${issue.path}: ${issue.message}` }) }
}

interface Node { type?: string, format?: string, maxLength?: number, pattern?: string, anyOf?: Node[], oneOf?: Node[], allOf?: Node[], properties?: Record<string, Node> }

// The schema node of a top-level field, found through `allOf` members as well.
function propertyOf(schema: Node, key: string): Node | undefined {
  return schema.properties?.[key] ?? schema.allOf?.map(member => propertyOf(member, key)).find(found => found !== undefined)
}

// Whether text would break the schema node or, in a union such as a nullable field, every member that takes text: a format such as an email, a length or a pattern.
function breaks(node: Node, text: string): boolean {
  const members = [...node.anyOf ?? [], ...node.oneOf ?? []].filter(member => member.type === undefined || member.type === 'string')

  if (members.length > 0 && !members.some(member => !breaks(member, text)))
    return true

  if (node.format !== undefined || (node.maxLength !== undefined && text.length > node.maxLength))
    return true

  try {
    return node.pattern !== undefined && !new RegExp(node.pattern, 'u').test(text)
  }
  catch {
    return true
  }
}

// A copy of an entry with the `unique` values another entry holds already made free, as a copy kept as they are would be refused: text gets a suffix like the slug does, unless the suffixed text would break its own field (a length, a pattern, a format), and any other value is left for the editor to give. A required field keeps its value then, so the refusal names it. `siblings` are the entries the check counts, those of the copy's own locale.
export function withFreeUniques(schema: JsonSchema, data: Record<string, unknown>, siblings: { data?: Record<string, unknown> | undefined }[], suffixed: (value: string, taken: Set<string>) => string): Record<string, unknown> {
  const copy = { ...data }
  const fields = fieldsOf(schema)

  for (const key of uniqueKeys(schema)) {
    const value = copy[key]

    if (typeof value === 'string') {
      const free = suffixed(value, new Set(siblings.map(entry => String(entry.data?.[key]))))
      const field = fields.find(each => each.key === key)
      const node = propertyOf(schema as Node, key)
      const fits = node === undefined || !breaks(node, free)

      if (fits)
        copy[key] = free
      else if (field?.required !== true)
        delete copy[key]
    }
    else if (value !== undefined && value !== null) {
      delete copy[key]
    }
  }

  return copy
}
