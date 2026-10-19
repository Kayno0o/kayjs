import type { Static } from 'elysia'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { t as elysiaSchema } from 'elysia'
import { TypeCompiler } from 'elysia/type-system'
import { s } from 'kay'
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

  it('leaves Elysia out of an island, and throws saying why when one calls it', async () => {
    const plain = await browserBundle('import { signal } from \'kay\'\n\nexport const count = signal(1)\n')
    const calling = await browserBundle('import { s } from \'kay\'\n\nexport const schema = () => s.String()\n')
    const secret = await browserBundle('import { s } from \'kay\'\n\nexport const schema = () => s.Secret()\n')

    expect(secret).toContain('builds a schema on the server')
    expect(plain).not.toContain('elysia')
    expect(plain.length).toBeLessThan(20_000)
    expect(calling.length).toBeLessThan(20_000)

    const { schema } = await import(`data:text/javascript;base64,${Buffer.from(calling).toString('base64')}`) as { schema: () => unknown }
    const { schema: secretSchema } = await import(`data:text/javascript;base64,${Buffer.from(secret).toString('base64')}`) as { schema: () => unknown }

    expect(secretSchema).toThrow('s.Secret() builds a schema on the server')

    expect(schema).toThrow('kay: s.String() builds a schema on the server, and kay\'s `s` is not in the browser; keep schemas in a module only the server imports')
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
})
