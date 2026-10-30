import type { TSchema } from 'elysia'
import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { getSchemaValidator, t } from 'elysia'
import { nativeConstraints } from '../src/runtime/form'
import { DEFAULT_MAX_LENGTH, withDefaultBounds } from '../src/runtime/schema-bounds'
import { testSite } from '../src/test'

type Fields = Record<string, { maxLength?: number }>

const fieldsOf = (schema: unknown): Fields => (schema as { properties: Fields }).properties
const bounded = (schema: TSchema) => withDefaultBounds(schema)

describe('the default bound of an action\'s strings', () => {
  it('bounds a string, one in an array, an optional one and one in a union to 10,000 characters', () => {
    expect(DEFAULT_MAX_LENGTH).toBe(10_000)

    const fields = fieldsOf(bounded(t.Object({ body: t.String(), tags: t.Array(t.String()), note: t.Optional(t.String()), either: t.Union([t.String(), t.Number()]) })))

    expect(fields.body!.maxLength).toBe(DEFAULT_MAX_LENGTH)
    expect((fields.tags as unknown as { items: { maxLength: number } }).items.maxLength).toBe(DEFAULT_MAX_LENGTH)
    expect(fields.note!.maxLength).toBe(DEFAULT_MAX_LENGTH)
    expect((fields.either as unknown as { anyOf: { maxLength?: number }[] }).anyOf[0]!.maxLength).toBe(DEFAULT_MAX_LENGTH)
  })

  it('keeps a bound the schema declares, an enum, a const, and a secret', () => {
    const fields = fieldsOf(bounded(t.Object({ title: t.String({ maxLength: 40 }), kind: t.String({ enum: ['a'] }), fixed: t.String({ const: 'x' }), password: t.String() })))

    expect(fields.title!.maxLength).toBe(40)
    expect(fields.kind!.maxLength).toBeUndefined()
    expect(fields.fixed!.maxLength).toBeUndefined()
    expect(fields.password!.maxLength).toBeUndefined()
  })

  it('reads a tuple, a record and a nested object through, validating as the schema did', () => {
    const given = t.Object({ pair: t.Tuple([t.String(), t.String()]), words: t.Record(t.String(), t.String()), inner: t.Object({ text: t.String() }) })
    const checked = getSchemaValidator(bounded(given))
    const long = 'x'.repeat(DEFAULT_MAX_LENGTH + 1)
    const fine = { pair: ['a', 'b'], words: { a: 'b' }, inner: { text: 'c' } }

    expect(checked.Check(fine)).toBe(true)
    expect(checked.Check({ ...fine, pair: ['a', long] })).toBe(false)
    expect(checked.Check({ ...fine, words: { a: long } })).toBe(false)
    expect(checked.Check({ ...fine, inner: { text: long } })).toBe(false)
  })

  it('refuses a string past the bound with the error of a declared maxLength, and leaves the schema it was given alone', () => {
    const given = t.Object({ body: t.String() })
    const declared = getSchemaValidator(t.Object({ body: t.String({ maxLength: DEFAULT_MAX_LENGTH }) }))
    const checked = getSchemaValidator(bounded(given))
    const long = { body: 'x'.repeat(DEFAULT_MAX_LENGTH + 1) }

    expect(checked.Check({ body: 'x'.repeat(DEFAULT_MAX_LENGTH) })).toBe(true)
    expect(checked.Check(long)).toBe(false)
    expect([...checked.Errors(long)].map(error => error.message)).toEqual([...declared.Errors(long)].map(error => error.message))
    expect((given.properties.body as { maxLength?: number }).maxLength).toBeUndefined()
  })

  it('reaches the maxlength a form puts on the field', () => {
    const field = fieldsOf(bounded(t.Object({ body: t.String() }))).body as Parameters<typeof nativeConstraints>[0]

    expect(nativeConstraints(field, false)).toContainEqual(['maxlength', '10000'])
  })
})

describe('an action a page exports', () => {
  const site = testSite({ root: 'tests/fixtures/island-action', islands: false })

  afterAll(async () => {
    await (await site).close()
  })

  it('is bounded when the server registers it, whatever builder wrote its schema', async () => {
    const { local } = await import(join(import.meta.dir, 'fixtures/island-action/src/routes/untyped.kay')) as { local: Action<{ name: string }, string> }
    const served = await site

    expect(await served.call(local, { name: 'x'.repeat(DEFAULT_MAX_LENGTH) })).toHaveLength(DEFAULT_MAX_LENGTH)
    await expect(served.call(local, { name: 'x'.repeat(DEFAULT_MAX_LENGTH + 1) })).rejects.toThrow()
    expect(fieldsOf((local as unknown as { schema: unknown }).schema).name!.maxLength).toBe(DEFAULT_MAX_LENGTH)
  })
})

describe('an action an _actions module exports', () => {
  const site = testSite({ root: 'tests/fixtures/island-action', islands: false })

  afterAll(async () => {
    await (await site).close()
  })

  it('is bounded as the ones a page exports are', async () => {
    const { shared } = await import(join(import.meta.dir, 'fixtures/island-action/src/routes/_actions.kay')) as { shared: Action<{ note: string }, string> }
    const served = await site

    expect(await served.call(shared, { note: 'x'.repeat(DEFAULT_MAX_LENGTH) })).toHaveLength(DEFAULT_MAX_LENGTH)
    await expect(served.call(shared, { note: 'x'.repeat(DEFAULT_MAX_LENGTH + 1) })).rejects.toThrow()
  })
})

describe('a string in an API route\'s body', () => {
  const site = testSite({ root: 'tests/fixtures/island-action', islands: false })

  afterAll(async () => {
    await (await site).close()
  })

  it('takes the same default bound as an action\'s', async () => {
    const served = await site
    const post = async (name: string) => served.fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: name }) })

    expect((await post('x'.repeat(DEFAULT_MAX_LENGTH))).status).toBe(200)
    expect((await post('x'.repeat(DEFAULT_MAX_LENGTH + 1))).status).toBe(422)
  })
})
