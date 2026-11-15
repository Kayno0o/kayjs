import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { secretKeys } from '../src/check/secret-keys'
import { scratchDir } from './scratch'

async function fixed(files: Record<string, string>): Promise<{ text: Record<string, string>, found: Awaited<ReturnType<typeof secretKeys>> }> {
  const root = await scratchDir('secret-keys-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await secretKeys(root, {})

    await applySafeFixes(root, found)

    return { found, text: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-secret-keys', () => {
  it('renames mcp.key to token and wraps the header of proxy.key', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'export default { mcp: { key: { file: \'data/mcp-key\' }, path: \'/t\' }, proxy: { key: \'x-upstream-key\', open: [\'/a\'] } }\n',
    })

    expect(found).toHaveLength(2)
    expect(text['kay.config.ts']).toBe('export default { mcp: { token: { file: \'data/mcp-key\' }, path: \'/t\' }, proxy: { key: { header: \'x-upstream-key\' }, open: [\'/a\'] } }\n')
  })

  it('reports with no fix a key of false, a token written too, a spread, and the options of testSite', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'export default { mcp: { key: false } }\n',
      'a/kay.config.ts': 'export default { mcp: { key: true, token: true } }\n',
      'b/kay.config.ts': 'import base from \'./base\'\nexport default { proxy: { ...base, key: \'x\' } }\n',
      'tests/site.test.ts': 'import { testSite } from \'kay/test\'\nconst site = await testSite({ mcpKey: \'k\', proxyKey: \'p\', config: { mcp: { key: true } } })\n',
    })

    expect(found).toHaveLength(6)
    expect(found.filter(one => one.fixes === undefined)).toHaveLength(5)
    expect(text['kay.config.ts']).toContain('key: false')
    expect(text['tests/site.test.ts']).toContain('mcpKey: \'k\'')
    expect(text['tests/site.test.ts']).toContain('config: { mcp: { token: true } }')
  })

  it('leaves the new form, other files and other keys alone', async () => {
    const { found } = await fixed({
      'kay.config.ts': 'export default { mcp: { token: true }, proxy: { key: { header: \'x\', secret: { env: \'A\' } } }, seo: { key: 1 } }\n',
      'src/other.ts': 'export default { mcp: { key: true } }\n',
    })

    expect(found).toEqual([])
  })
})
