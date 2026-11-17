import { describe, expect, it } from 'bun:test'
import { action } from '../src/runtime/action'
import { s } from '../src/runtime/schema'

interface Described { schema: { type?: string, properties?: Record<string, unknown>, anyOf?: unknown[] }, protection?: unknown }

const described = (given: unknown) => given as Described

describe('action reads its first argument as the options or as the schema', () => {
  it('takes options with a record, a schema or a union as the input', () => {
    expect(Object.keys(described(action({ input: { n: s.int() } }, ({ n }) => n)).schema.properties ?? {})).toEqual(['n'])
    expect(described(action({ input: s.object({ n: s.int() }) }, ({ n }) => n)).schema.type).toBe('object')
    expect(described(action({ input: s.union([s.string(), s.int()]) }, input => input)).schema.anyOf).toHaveLength(2)
  })

  it('takes options with no input, or an input left undefined, as an action with none', () => {
    expect(described(action({}, () => 1)).schema.properties).toEqual({})
    expect(described(action({ input: undefined }, () => 1)).schema.properties).toEqual({})
  })

  it('keeps a record of fields, one of them named input, as the old form', () => {
    expect(Object.keys(described(action({ input: s.string(), other: s.int() }, () => 1)).schema.properties ?? {})).toEqual(['input', 'other'])
  })
})
