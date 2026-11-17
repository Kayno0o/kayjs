import type { TSchema } from 'elysia'
import type { Static } from '../src/runtime/schema'
import { describe, expect, expectTypeOf, it } from 'bun:test'
import { getSchemaValidator } from 'elysia'
import { DEFAULT_MAX_ITEMS, s } from '../src/runtime/schema'
import { DEFAULT_MAX_LENGTH } from '../src/runtime/schema-bounds'

const valid = (schema: TSchema, value: unknown) => getSchemaValidator(schema).Check(value)

describe('s, kay\'s own builders', () => {
  it('bounds a string in the builder, and takes min, max and a pattern', () => {
    const text = s.string()

    expect(text).toMatchObject({ type: 'string', maxLength: DEFAULT_MAX_LENGTH })
    expect(valid(text, 'x'.repeat(DEFAULT_MAX_LENGTH))).toBe(true)
    expect(valid(text, 'x'.repeat(DEFAULT_MAX_LENGTH + 1))).toBe(false)

    const bounded = s.string({ min: 2, max: 4, pattern: /^[a-z]+$/ })

    expect(bounded).toMatchObject({ minLength: 2, maxLength: 4, pattern: '^[a-z]+$' })
    expect(valid(bounded, 'abc')).toBe(true)
    expect(valid(bounded, 'a')).toBe(false)
    expect(valid(bounded, 'abcde')).toBe(false)
    expect(valid(bounded, 'AB')).toBe(false)
  })

  it('reads email, url and slug as formats of their own', () => {
    expect(valid(s.email(), 'a@b.fr')).toBe(true)
    expect(valid(s.email(), 'not an address')).toBe(false)
    expect(valid(s.url(), 'https://kay.dev/docs')).toBe(true)
    expect(valid(s.url(), 'javascript:alert(1)')).toBe(false)
    expect(valid(s.slug(), 'my-first-post')).toBe(true)
    expect(valid(s.slug(), 'My post')).toBe(false)
  })

  it('takes the same field options on every builder, as JSON Schema keywords', () => {
    const field = s.string({ default: 'a', error: 'Say more', label: 'Message', description: 'What you want to say', example: 'Hi' })

    expect(field).toMatchObject({ default: 'a', error: 'Say more', title: 'Message', description: 'What you want to say', examples: ['Hi'] })
    expect(s.int({ label: 'Age' })).toMatchObject({ title: 'Age' })
    expect(s.list(s.string(), { description: 'Tags' })).toMatchObject({ description: 'Tags' })
    expect(s.object({}, { label: 'Address' })).toMatchObject({ title: 'Address' })
  })

  it('makes a field optional in its object with optional: true, and types it so', () => {
    const shape = s.object({ title: s.string(), note: s.string({ optional: true }) })

    expectTypeOf<Static<typeof shape>>().toEqualTypeOf<{ title: string, note?: string }>()
    expect(valid(shape, { title: 'a' })).toBe(true)
    expect(valid(shape, { note: 'a' })).toBe(false)
  })

  it('refuses a key the shape lacks, unless extra is strip', () => {
    const shape = s.object({ a: s.string() })

    expect(shape).toMatchObject({ additionalProperties: false })
    expect(valid(shape, { a: 'x', b: 1 })).toBe(false)
    expect('additionalProperties' in s.object({ a: s.string() }, { extra: 'strip' })).toBe(false)
  })

  it('reads numbers as numbers and as the text of one', () => {
    expect(valid(s.int(), 3)).toBe(true)
    expect(valid(s.int(), 3.5)).toBe(false)
    expect(valid(s.int({ min: 1, max: 5 }), 6)).toBe(false)
    expect(valid(s.number(), 2.5)).toBe(true)
    expect(valid(s.number(), Number.POSITIVE_INFINITY)).toBe(false)
    expect(valid(s.boolean(), true)).toBe(true)
    expectTypeOf<Static<ReturnType<typeof s.int>>>().toEqualTypeOf<number>()
  })

  it('reads a date from ISO text only', () => {
    const date = s.date()

    expectTypeOf<Static<typeof date>>().toEqualTypeOf<Date>()
    expect(valid(date, '2026-03-01')).toBe(true)
    expect(valid(date, '2026-03-01T10:30:00Z')).toBe(true)
    expect(valid(date, '03/01/2026')).toBe(false)
    expect(valid(date, 1_700_000_000_000)).toBe(false)
  })

  it('takes the values of an enum from a list or from the keys of a record, with no default of its own', () => {
    const topic = s.enum(['sales', 'help'])
    const keyed = s.enum({ sales: 'Sales', help: 'Help' })

    expect(topic).toMatchObject({ enum: ['sales', 'help'] })
    expect('default' in topic).toBe(false)
    expect(keyed).toMatchObject({ enum: ['sales', 'help'] })
    expect(valid(topic, 'other')).toBe(false)
    expect(s.enum(['a', 'b'], { default: 'b' })).toMatchObject({ default: 'b' })
    expectTypeOf<Static<typeof keyed>>().toEqualTypeOf<'sales' | 'help'>()
    expect(() => s.enum({} as Record<string, string>)).toThrow('s.enum()')
  })

  it('builds literals, unions, records and bounded lists', () => {
    expect(valid(s.union([s.literal('a'), s.int()]), 'a')).toBe(true)
    expect(valid(s.union([s.literal('a'), s.int()]), 'b')).toBe(false)
    expect(valid(s.record(s.int()), { a: 1 })).toBe(true)

    const tags = s.list(s.string(), { min: 1, max: 2 })

    expect(valid(tags, [])).toBe(false)
    expect(valid(tags, ['a', 'b', 'c'])).toBe(false)
    expect(s.list(s.string())).toMatchObject({ maxItems: DEFAULT_MAX_ITEMS })
    expectTypeOf<Static<typeof tags>>().toEqualTypeOf<string[]>()
  })

  it('reads the sizes of a file as an action reads its maxSize', () => {
    expect(s.file({ maxSize: '5mb', type: 'application/pdf' })).toMatchObject({ maxSize: 5 * 1024 * 1024, extension: 'application/pdf' })
    expect(s.files({ maxSize: '600kb', max: 3 })).toMatchObject({ maxSize: 600 * 1024, maxItems: 3 })
    expect(() => s.file({ maxSize: '2m' as never })).toThrow('maxSize')
  })

  it('marks a secret and a public field of defineEnv', () => {
    expect(s.secret()).toMatchObject({ minLength: 32, secret: true, requiredInProduction: true })
    expect(s.public(s.string())).toMatchObject({ public: true })
  })

  it('keeps the PascalCase builders as they were', () => {
    expect(s.Object({ a: s.String() })).toMatchObject({ type: 'object' })
    expect(s.UnionKeys({ a: 1, b: 2 })).toMatchObject({ enum: ['a', 'b'] })
    expect(s.Optional(s.Numeric())).toBeDefined()
    expect(s.File({ maxSize: '2mb' })).toMatchObject({ maxSize: 2 * 1024 * 1024 })
  })
})
