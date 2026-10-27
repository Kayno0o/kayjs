import type { Static } from 'elysia'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Value } from '@sinclair/typebox/value'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { t as elysiaSchema } from 'elysia'
import { TypeCompiler } from 'elysia/type-system'
import { s } from 'kay'
import { readFields } from '../src/server/query'
import { scratchDir } from './scratch'

let dir: string

beforeAll(async () => {
  dir = await scratchDir('schema-')
})

afterAll(async () => rm(dir, { recursive: true, force: true }))

// Bundles `source` for the browser as an island's chunk is, answering the code.
async function browserBundle(source: string): Promise<string> {
  const entry = join(dir, `entry-${Bun.hash(source).toString(36)}.ts`)

  await Bun.write(entry, source)

  const build = await Bun.build({ entrypoints: [entry], target: 'browser' })

  if (!build.success)
    throw new AggregateError(build.logs, 'browser build failed')

  return build.outputs[0]!.text()
}

describe('s from kay', () => {
  it('is Elysia\'s own schema builder on the server, with Secret added', () => {
    expect(s.Object).toBe(elysiaSchema.Object)
    expect(s.String).toBe(elysiaSchema.String)
    expect(s.Secret().minLength).toBe(32)
    expect(s.Object({ title: s.String() }).type).toBe('object')
  })

  it('lets an island read the type of a schema its shared module builds, with nothing of the module in the bundle', async () => {
    await Bun.write(join(dir, 'shared.ts'), 'import type { Static } from \'kay\'\nimport { s } from \'kay\'\n\nexport const choice = s.Union([s.Literal(\'smash\'), s.Literal(\'pass\')])\nexport type Choice = Static<typeof choice>\n')

    const bundle = await browserBundle('import type { Choice } from \'./shared\'\nimport type { choice } from \'./shared\'\n\nexport const pick = (value: Choice, from: typeof choice) => [value, from]\n')

    expect(bundle).not.toContain('builds a schema')
    expect(bundle).not.toContain('smash')
  })

  it('lets an island load a module that builds schemas, with no Elysia and no validator in its chunk', async () => {
    const shared = 'import type { Static } from \'kay\'\nimport { s } from \'kay\'\n\nexport const SHAPE = s.Object({ pick: s.Union([s.Literal(\'smash\'), s.Literal(\'pass\')]), key: s.Secret(), pub: s.Public(s.String()), topic: s.UnionKeys({ a: 1 }) })\nexport type Shape = Static<typeof SHAPE>\nexport const label = \'ok\'\n'

    await Bun.write(join(dir, 'built.ts'), shared)

    const plain = await browserBundle('import { signal } from \'kay\'\n\nexport const count = signal(1)\n')
    const building = await browserBundle('import { label } from \'./built\'\n\nexport const read = () => label\n')

    expect(building).not.toContain('elysia')
    expect(building).not.toContain('typebox')
    expect(building.length).toBeLessThan(20_000)
    expect(building.length - plain.length).toBeLessThan(2_000)

    const { read } = await import(`data:text/javascript;base64,${Buffer.from(building).toString('base64')}`) as { read: () => string }

    expect(read()).toBe('ok')
  })

  it('throws saying why when an island reads or validates with a schema it built', async () => {
    const bundle = await browserBundle('import { s } from \'kay\'\n\nconst SHAPE = s.Object({ name: s.String() })\n\nexport const inert = () => [typeof (SHAPE as unknown as { then?: unknown }).then, JSON.stringify(SHAPE)]\nexport const read = () => (SHAPE as unknown as { properties: unknown }).properties\n')
    const { inert, read } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`) as { inert: () => unknown[], read: () => unknown }

    expect(inert()).toEqual(['undefined', '{}'])
    expect(read).toThrow('a schema is inert in the browser')
  })

  it('builds an enum over a record\'s keys, typed as their union', () => {
    const TOPICS = { billing: 'Billing', support: 'Support' }
    const topic = s.UnionKeys(TOPICS, { error: 'Pick a topic' })
    const check = TypeCompiler.Compile(topic)
    // `bun run check` fails when the keys are typed as plain strings, or a widened record stays assignable.
    const typed: Static<typeof topic> = 'billing'
    // @ts-expect-error -- not a key of the record
    const other: Static<typeof topic> = 'sales'

    expect(topic.enum).toEqual(['billing', 'support'])
    expect(topic.error).toBe('Pick a topic')
    expect(check.Check('support')).toBe(true)
    expect(check.Check('sales')).toBe(false)
    expect(check.Check('toString')).toBe(false)
    expect([typed as string, other as string]).toEqual(['billing', 'sales'])
    expect(() => s.UnionKeys({})).toThrow('kay: s.UnionKeys() takes a record with at least one key')
  })

  it('leaves an enum without a default unless given one, so a missing value is not filled in', () => {
    const plain = s.UnionEnum(['critical', 'low'])
    const given = s.UnionEnum(['critical', 'low'], { default: 'low' })
    const none = s.UnionEnum(['critical', 'low'], { default: undefined })
    const shape = s.Object({ level: plain, maybe: s.Optional(s.UnionEnum(['a', 'b'])) })
    const check = TypeCompiler.Compile(shape)

    expect('default' in plain).toBe(false)
    expect(given.default).toBe('low')
    expect('default' in none).toBe(true)
    expect(Value.Default(shape, {})).toEqual({})
    expect(Value.Default(s.Object({ maybe: s.Optional(s.UnionEnum(['a', 'b'])) }), {})).toEqual({})
    expect(check.Check({})).toBe(false)
    expect(check.Check({ level: 'low' })).toBe(true)
    expect(check.Check({ level: 'other' })).toBe(false)
    expect(readFields(shape, {})).toEqual({ refused: new Map([['level', expect.any(String)]]) })
    expect(readFields(shape, { level: 'low' })).toEqual({ value: { level: 'low' } })
    expect('default' in s.UnionKeys({ a: 1 })).toBe(false)
  })
})
