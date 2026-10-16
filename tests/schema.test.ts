import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { t as elysiaSchema } from 'elysia'
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
  it('is Elysia\'s own schema builder on the server', () => {
    expect(s).toBe(elysiaSchema)
    expect(s.Object({ title: s.String() }).type).toBe('object')
  })

  it('leaves Elysia out of an island, and throws saying why when one calls it', async () => {
    const plain = await browserBundle('import { signal } from \'kay\'\n\nexport const count = signal(1)\n')
    const calling = await browserBundle('import { s } from \'kay\'\n\nexport const schema = () => s.String()\n')

    expect(plain).not.toContain('elysia')
    expect(plain.length).toBeLessThan(20_000)
    expect(calling.length).toBeLessThan(20_000)

    const { schema } = await import(`data:text/javascript;base64,${Buffer.from(calling).toString('base64')}`) as { schema: () => unknown }

    expect(schema).toThrow('kay: s.String() builds a schema on the server, and kay\'s `s` is not in the browser; keep schemas in a module only the server imports')
  })
})
