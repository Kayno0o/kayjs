import type { TSchema } from 'elysia'
import { isSecret } from './form'

// The longest a string field of an action takes when its schema declares no bound of its own: room for a long message, under the request body limit.
export const DEFAULT_MAX_LENGTH = 10_000

// A string of these formats is as long as its format allows, so a bound beside it only adds noise to the document, as `t.Date`'s `date-time` shows.
const FORMATTED = new Set(['date-time', 'date', 'time'])
const WRAPPERS = ['anyOf', 'oneOf', 'allOf'] as const
const NESTED = ['items', 'additionalProperties', 'not'] as const

function isSchema(value: unknown): value is TSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bounded(value: unknown, field: string | undefined): unknown {
  return isSchema(value) ? withDefaultBounds(value, field) : value
}

// A copy of an action's schema in which every string field with no `maxLength`, `enum`, `const` or date format of its own takes `DEFAULT_MAX_LENGTH`, so a schema written with Elysia's `t` is bounded too and the server, the form's `maxlength` and the tool's schema read one bound. A field named like a secret, which is checked or hashed rather than kept, is left alone.
export function withDefaultBounds<Schema extends TSchema>(schema: Schema, field?: string): Schema {
  const node = schema as Record<string, unknown>

  if (node.type === 'string' && field !== undefined && isSecret(field))
    return schema

  const copy: Record<PropertyKey, unknown> = { ...node }

  if (node.type === 'string' && node.maxLength === undefined && !('enum' in node) && !('const' in node) && !FORMATTED.has(node.format as string))
    copy.maxLength = DEFAULT_MAX_LENGTH

  for (const keyword of ['properties', 'patternProperties'] as const) {
    const members = node[keyword]

    if (isSchema(members))
      copy[keyword] = Object.fromEntries(Object.entries(members).map(([key, value]) => [key, bounded(value, keyword === 'properties' ? key : field)]))
  }

  for (const keyword of NESTED) {
    if (isSchema(node[keyword]))
      copy[keyword] = bounded(node[keyword], field)
  }

  for (const keyword of [...WRAPPERS, 'items', 'prefixItems'] as const) {
    if (Array.isArray(node[keyword]))
      copy[keyword] = (node[keyword] as unknown[]).map(inner => bounded(inner, field))
  }

  return copy as Schema
}
