import type { TSchema } from 'elysia'
import { describe, expect, it } from 'bun:test'
import { getSchemaValidator, t } from 'elysia'
import { action } from '../src/runtime/action'
import { nativeConstraints } from '../src/runtime/form'
import { s } from '../src/runtime/schema'
import { DEFAULT_MAX_LENGTH, withDefaultBounds } from '../src/runtime/schema-bounds'

type Fields = Record<string, { maxLength?: number }>

const fieldsOf = (schema: unknown): Fields => (schema as { properties: Fields }).properties

// The schema an action carries once the server registered its route.
function registered(made: unknown): unknown {
  const served = made as { schema: TSchema }

  served.schema = withDefaultBounds(served.schema)

  return served.schema
}

describe('the default bound of an action\'s strings', () => {
  it('bounds s.String and a t.String of an action alike, to 10,000 characters', () => {
    expect(DEFAULT_MAX_LENGTH).toBe(10_000)
    expect(s.String().maxLength).toBe(DEFAULT_MAX_LENGTH)

    const fields = fieldsOf(registered(action(t.Object({ body: t.String(), tags: t.Array(t.String()), note: t.Optional(t.String()) }), () => 1)))

    expect(fields.body!.maxLength).toBe(DEFAULT_MAX_LENGTH)
    expect((fields.tags as unknown as { items: { maxLength: number } }).items.maxLength).toBe(DEFAULT_MAX_LENGTH)
    expect(fields.note!.maxLength).toBe(DEFAULT_MAX_LENGTH)
  })

  it('keeps a bound the schema declares, an enum, a const, and a secret', () => {
    const own = s.String({ maxLength: 40 })

    expect(own.maxLength).toBe(40)
    expect(s.String({ enum: ['a', 'b'] }).maxLength).toBeUndefined()
    expect(s.String({ const: 'x' }).maxLength).toBeUndefined()

    const fields = fieldsOf(registered(action(t.Object({ title: t.String({ maxLength: 40 }), kind: t.String({ enum: ['a'] }), password: t.String() }), () => 1)))

    expect(fields.title!.maxLength).toBe(40)
    expect(fields.kind!.maxLength).toBeUndefined()
    expect(fields.password!.maxLength).toBeUndefined()
  })

  it('refuses a string past the bound with the error of a declared maxLength, and does not change the schema it was given', () => {
    const given = t.Object({ body: t.String() })
    const declared = getSchemaValidator(t.Object({ body: t.String({ maxLength: DEFAULT_MAX_LENGTH }) }))
    const bounded = getSchemaValidator(registered(action(given, () => 1)) as typeof given)
    const long = { body: 'x'.repeat(DEFAULT_MAX_LENGTH + 1) }

    expect(bounded.Check({ body: 'x'.repeat(DEFAULT_MAX_LENGTH) })).toBe(true)
    expect(bounded.Check(long)).toBe(false)
    expect([...bounded.Errors(long)].map(error => error.message)).toEqual([...declared.Errors(long)].map(error => error.message))
    expect((given.properties.body as { maxLength?: number }).maxLength).toBeUndefined()
  })

  it('reaches the maxlength a form puts on the field', () => {
    const field = fieldsOf(registered(action(t.Object({ body: t.String() }), () => 1))).body as Parameters<typeof nativeConstraints>[0]

    expect(nativeConstraints(field, false)).toContainEqual(['maxlength', '10000'])
  })
})
