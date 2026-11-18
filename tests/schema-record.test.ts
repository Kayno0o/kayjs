import type { Elysia } from 'elysia'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'bun:test'
import { s } from '../src/runtime'
import { schemaOf } from '../src/runtime/schema-record'
import { defineEnv } from '../src/server'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

describe('schemaOf', () => {
  it('leaves a schema as it is and reads a record as the strict object of its fields', () => {
    const own = s.object({ a: s.string() })

    expect(schemaOf(own)).toBe(own)

    const built = schemaOf({ name: s.string({ max: 4 }), age: s.int({ optional: true }) })

    expect(built).toMatchObject({ type: 'object', required: ['name'], additionalProperties: false })
    expect(Object.keys(built.properties)).toEqual(['name', 'age'])
    expect(schemaOf({})).toMatchObject({ type: 'object', additionalProperties: false })
    expect(schemaOf({})).not.toHaveProperty('required')
  })
})

describe('a plain record as the schema of an action', () => {
  const ADD = '/_kay/action/routes/index.kay/add'
  let dir = ''
  let app: Elysia
  const calls: unknown[] = []

  const post = async (fields: Record<string, string>) => {
    const response = await app.handle(new Request(`http://localhost${ADD}`, { method: 'POST', headers: { origin: 'http://localhost', accept: 'application/json' }, body: new URLSearchParams(fields) }))

    return { status: response.status, text: await response.text() }
  }

  beforeAll(async () => {
    ;(globalThis as { schemaRecordCalls?: unknown[] }).schemaRecordCalls = calls
    dir = await scratchDir('schema-record-')
    await Bun.write(join(dir, 'routes/index.kay'), '--- server\nimport { action, s } from \'kay\'\n\nexport const add = action({ title: s.string({ max: 5 }), note: s.string({ optional: true }) }, (input) => { ;(globalThis as { schemaRecordCalls?: unknown[] }).schemaRecordCalls?.push(input) })\n---\nform(action={add})\n  input(name="title")\n')
    app = await pages({ root: dir, dirs: { routes: 'routes' }, prebuilt: false, security: false, guards: { default: 'open' } })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('runs the handler on a valid body, the optional field left out, and drops a key the record lacks', async () => {
    expect((await post({ title: 'abc' })).status).toBe(303)
    expect((await post({ title: 'abc', note: 'n', extra: 'x' })).status).toBe(303)
    expect(calls).toEqual([{ title: 'abc' }, { title: 'abc', note: 'n' }])
  })

  it('refuses a value the record bounds', async () => {
    expect((await post({ title: 'abcdef' })).status).toBe(422)
    expect((await post({})).status).toBe(422)
  })
})

describe('a plain record as the schema of defineEnv', () => {
  it('reads its fields from the environment it is given, with defaults and types', () => {
    const env = defineEnv({ PORT: s.int({ default: 3000 }), NAME: s.string(), DEBUG: s.boolean({ optional: true }) }, { NAME: 'kay', PORT: '8080' })

    expect(env).toEqual({ PORT: 8080, NAME: 'kay' })
    expectTypeOf(env.PORT).toEqualTypeOf<number>()
    expectTypeOf(env.NAME).toEqualTypeOf<string>()
    expect(defineEnv({ PORT: s.int({ default: 3000 }) }, {}).PORT).toBe(3000)
  })

  it('refuses a missing required variable', () => {
    expect(() => defineEnv({ NAME: s.string() }, {})).toThrow('NAME')
  })
})

describe('email, url and slug take their own options only', () => {
  it('refuses an option the builder does not know', () => {
    // @ts-expect-error min is not an option of an email
    s.email({ min: 'x' })

    // @ts-expect-error a typo of max
    s.slug({ maxx: 3 })

    expect(s.url({ optional: true, label: 'Site' })).toBeDefined()
  })
})
