import type { Schema, Static } from '../src/runtime/schema'
import { describe, expect, expectTypeOf, it } from 'bun:test'
import { s } from '../src/runtime/schema'

describe('Schema', () => {
  it('is what s builds, and s.typebox is the same builder', () => {
    const fields = s.Object({ title: s.String() })

    expectTypeOf(fields).toExtend<Schema>()
    expectTypeOf<Static<typeof fields>>().toEqualTypeOf<{ title: string }>()
    expect(s.typebox.Object({ n: s.typebox.Number() })).toMatchObject({ type: 'object' })
    expect(s.typebox).toBe(s.typebox)
  })
})
