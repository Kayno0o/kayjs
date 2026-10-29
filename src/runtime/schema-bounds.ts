import type { TSchema } from 'elysia'
import { isSecret } from './form'

// The longest a string field takes when its schema declares no bound of its own: room for a long message, under the request body limit.
export const DEFAULT_MAX_LENGTH = 10_000

const WRAPPERS = ['anyOf', 'oneOf', 'allOf'] as const

// A copy of an action's schema in which every string field with no `maxLength`, `enum` or `const` of its own takes `DEFAULT_MAX_LENGTH`, as `s.String` does, so a schema written with Elysia's `t` is bounded too. A secret, which is checked or hashed rather than kept, is left alone.
export function withDefaultBounds<Schema extends TSchema>(schema: Schema, field?: string): Schema {
  const node = schema as Record<string, unknown>

  if (typeof node !== 'object' || node === null)
    return schema

  const copy: Record<PropertyKey, unknown> = { ...node }

  if (node.type === 'string' && field !== undefined && isSecret(field))
    return schema

  if (node.type === 'string' && !('maxLength' in node) && !('enum' in node) && !('const' in node) && node.secret !== true)
    copy.maxLength = DEFAULT_MAX_LENGTH

  if (typeof node.properties === 'object' && node.properties !== null)
    copy.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, withDefaultBounds(value as TSchema, key)]))

  if (typeof node.items === 'object' && node.items !== null)
    copy.items = withDefaultBounds(node.items as TSchema, field)

  for (const wrapper of WRAPPERS) {
    if (Array.isArray(node[wrapper]))
      copy[wrapper] = (node[wrapper] as TSchema[]).map(inner => withDefaultBounds(inner, field))
  }

  return copy as Schema
}
