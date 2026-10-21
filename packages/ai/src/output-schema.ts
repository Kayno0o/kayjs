// What a provider's JSON-schema output takes of a kay schema: the shape (types, properties, required, items, unions, enums) and every object closed to other fields.
// A bound it cannot hold (lengths, ranges, formats, patterns) moves into the description for the model to read, and kayjs-ai checks it on the answer.
import { configError } from 'kay/library'

const KEPT = new Set(['type', 'properties', 'required', 'items', 'anyOf', 'enum', 'const', 'description', 'title'])
// Marks of kay's own that tell a model nothing.
const DROPPED = new Set(['error', 'default', 'examples', '$id', '$schema', 'additionalProperties'])

type Node = Record<string, unknown>

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Free keys and intersections cannot be held to a closed object, so a model would be told the field is empty.
const UNSUPPORTED = ['patternProperties', 'allOf']

function simplify(value: unknown): unknown {
  if (!isNode(value))
    return value

  for (const key of UNSUPPORTED) {
    if (key in value)
      throw configError('a schema holds an s.Record or an s.Intersect, which a model cannot be held to; name the fields with s.Object({ ... })')
  }

  const out: Node = {}
  const moved: string[] = []

  for (const [key, member] of Object.entries(value)) {
    if (key === 'properties' && isNode(member))
      out.properties = Object.fromEntries(Object.entries(member).map(([name, property]) => [name, simplify(property)]))
    else if (key === 'items')
      out.items = Array.isArray(member) ? member.map(simplify) : simplify(member)
    else if (key === 'anyOf' && Array.isArray(member))
      out.anyOf = member.map(simplify)
    else if (KEPT.has(key))
      out[key] = member
    else if (!DROPPED.has(key))
      moved.push(`${key}: ${JSON.stringify(member)}`)
  }

  if (out.type === 'object') {
    out.properties ??= {}
    out.additionalProperties = false
  }

  if (moved.length > 0)
    out.description = typeof out.description === 'string' && out.description !== '' ? `${out.description}\n\n{${moved.join(', ')}}` : `{${moved.join(', ')}}`

  return out
}

const outputs = new WeakMap<object, object>()

export function outputSchema(schema: object): object {
  let output = outputs.get(schema)

  if (output === undefined) {
    output = simplify(schema) as object
    outputs.set(schema, output)
  }

  return output
}

// Whether every object of the schema requires all of its fields, which is what OpenAI's strict mode takes.
export function allRequired(schema: unknown): boolean {
  if (Array.isArray(schema))
    return schema.every(allRequired)

  if (!isNode(schema))
    return true

  const { properties, required } = schema

  if (isNode(properties)) {
    const names = Object.keys(properties)

    if (!Array.isArray(required) ? names.length > 0 : names.some(name => !required.includes(name)))
      return false

    if (!Object.values(properties).every(allRequired))
      return false
  }

  return allRequired(schema.items) && allRequired(schema.anyOf)
}
