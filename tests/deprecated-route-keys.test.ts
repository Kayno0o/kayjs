import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { routeKeys } from '../src/check/route-keys'
import { scratchDir } from './scratch'

async function fixed(files: Record<string, string>): Promise<{ text: Record<string, string>, found: Awaited<ReturnType<typeof routeKeys>> }> {
  const root = await scratchDir('route-keys-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await routeKeys(root, {})

    await applySafeFixes(root, found)

    return { found, text: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

const config = (body: string) => ({ 'kay.config.ts': `export default ${body}\n` })

describe('deprecated-route-keys', () => {
  it('writes the paths in endpoints and empties the bags that held only them', async () => {
    const { found, text } = await fixed(config('{ mcp: { path: \'/tools\' }, health: { path: \'/up\' } }'))

    expect(found).toHaveLength(2)
    expect(found[0]!.message).toContain('`mcp.path` is `endpoints.mcp` since 1.105')
    expect(text['kay.config.ts']).toBe('export default { endpoints: { mcp: \'/tools\', health: \'/up\' }, mcp: {}, health: {} }\n')
  })

  it('keeps the other keys of a bag, and takes serve.apiPrefix and the bags of ops', async () => {
    const { text } = await fixed(config('{ lang: \'en\', serve: { apiPrefix: \'/v1\', compress: false }, ops: { metrics: { path: \'/m\' }, jobs: { path: \'/j\', guards: [] } } }'))

    expect(text['kay.config.ts']).toBe('export default { lang: \'en\', endpoints: { metrics: \'/m\', jobs: \'/j\', api: \'/v1\' }, serve: { compress: false }, ops: { metrics: {}, jobs: { guards: [] } } }\n')
  })

  it('rewrites referencePath as reference: { path }', async () => {
    const { found, text } = await fixed(config('{ openapi: { reference: true, referencePath: \'/docs/api\' } }'))

    expect(found).toHaveLength(1)
    expect(text['kay.config.ts']).toBe('export default { openapi: { reference: { path: \'/docs/api\' } } }\n')
  })

  it('reports with no fix where endpoints exists, the object spreads or a comment would go', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'export default { endpoints: { api: \'/v1\' }, mcp: { path: \'/t\' } }\n',
      'a/kay.config.ts': 'import base from \'./base\'\nexport default { ...base, health: { path: \'/up\' } }\n',
      'b/kay.config.ts': 'export default { health: { /* why */ path: \'/up\' } }\n',
    })

    expect(found).toHaveLength(3)
    expect(found.every(one => one.fixes === undefined)).toBe(true)
    expect(text['kay.config.ts']).toContain('mcp: { path')
  })

  it('leaves the grouped form and other files alone', async () => {
    const { found } = await fixed({
      'kay.config.ts': 'export default { endpoints: { mcp: \'/t\' }, mcp: true, openapi: { reference: true }, ops: { health: { check: () => true } } }\n',
      'src/other.ts': 'export default { mcp: { path: \'/t\' } }\n',
    })

    expect(found).toEqual([])
  })
})
