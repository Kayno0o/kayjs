import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { t as elysiaSchema } from 'elysia'
import { t } from 'kay'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, '.schema-'))
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

describe('t from kay', () => {
  it('is Elysia\'s own schema builder on the server', () => {
    expect(t).toBe(elysiaSchema)
    expect(t.Object({ title: t.String() }).type).toBe('object')
  })

  it('leaves Elysia out of an island, and throws saying why when one calls it', async () => {
    const plain = await browserBundle('import { signal } from \'kay\'\n\nexport const count = signal(1)\n')
    const calling = await browserBundle('import { t } from \'kay\'\n\nexport const schema = () => t.String()\n')

    expect(plain).not.toContain('elysia')
    expect(plain.length).toBeLessThan(20_000)
    expect(calling.length).toBeLessThan(20_000)

    const { schema } = await import(`data:text/javascript;base64,${Buffer.from(calling).toString('base64')}`) as { schema: () => unknown }

    expect(schema).toThrow('kay: t.String() builds a schema on the server')
  })
})
