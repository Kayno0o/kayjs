import type { Schema, Static } from '../src/runtime/schema'
import { describe, expect, expectTypeOf, it } from 'bun:test'
import { t } from 'elysia'
import { s } from '../src/runtime/schema'

describe('Schema', () => {
  it('is what s builds', () => {
    const fields = s.Object({ title: s.String() })

    expectTypeOf(fields).toExtend<Schema>()
    expectTypeOf<Static<typeof fields>>().toEqualTypeOf<{ title: string }>()
  })

  it('accepts an Elysia schema', () => {
    expectTypeOf(t.Object({ id: t.Number() })).toExtend<Schema>()
  })

  it('builds inert stand-ins in the browser', async () => {
    const { s: browser } = await import('../src/runtime/schema.client')

    expect(() => browser.Object({ a: browser.String() })).not.toThrow()
    expect(() => browser.object({ a: browser.string() })).not.toThrow()
  })
})
