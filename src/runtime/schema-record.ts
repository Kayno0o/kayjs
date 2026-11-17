import type { t } from 'elysia'
import type { Schema } from './schema'

// A plain record of schemas, which every API taking a schema reads as the object of those fields.
export type SchemaShape = Record<string, Schema>

// The object schema of a record, as `s.object(shape)` types it.
export type ObjectOf<Shape extends SchemaShape> = ReturnType<typeof t.Object<Shape>>

// Either a schema or the record of one.
export type SchemaInput = Schema | SchemaShape

export type SchemaOf<Input extends SchemaInput> = Input extends Schema ? Input : Input extends SchemaShape ? ObjectOf<Input> : never

// The symbols TypeBox reads a schema and an optional field by, so this module needs no builder, which would carry Elysia into an island importing it.
const KIND = Symbol.for('TypeBox.Kind')
const OPTIONAL = Symbol.for('TypeBox.Optional')

export function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && KIND in value
}

// A schema as it is, a record as the strict object of its fields: a key the record lacks is refused, as `s.object(shape)` does.
export function schemaOf<Input extends SchemaInput>(input: Input): SchemaOf<Input> {
  if (isSchema(input))
    return input as SchemaOf<Input>

  const required = Object.entries(input).filter(([, field]) => !(OPTIONAL in field)).map(([name]) => name)

  return { [KIND]: 'Object', type: 'object', properties: { ...input }, ...required.length > 0 && { required }, additionalProperties: false } as unknown as SchemaOf<Input>
}
