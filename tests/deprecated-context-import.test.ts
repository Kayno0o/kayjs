import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { contextImport } from '../src/check/context-import'
import { envFiles } from '../src/check/env-files'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function fixed(files: Record<string, string>, check: typeof contextImport): Promise<{ text: Record<string, string>, found: Awaited<ReturnType<typeof contextImport>> }> {
  const root = await scratchDir('context-import-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await check(root, {})

    await applySafeFixes(root, found)

    return { found, text: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-context-import', () => {
  it('moves defineContext to kay/server, as a new import when the line holds others', async () => {
    const { found, text } = await fixed({
      'src/a.ts': 'import { defineContext } from \'kay/library\'\n\nexport default defineContext({})\n',
      'src/b.ts': 'import { userOf, defineContext } from \'kay/library\'\n\nexport default defineContext({})\n',
      'src/c.ts': 'import { defineContext, userOf } from \'kay/library\'\n\nexport default defineContext({})\n',
      'src/d.ts': 'import { defineContext } from \'./mine\'\n',
    }, contextImport)

    expect(found).toHaveLength(3)
    expect(text['src/a.ts']).toBe('import { defineContext } from \'kay/server\'\n\nexport default defineContext({})\n')
    expect(text['src/b.ts']).toBe('import { userOf } from \'kay/library\'\nimport { defineContext } from \'kay/server\'\n\nexport default defineContext({})\n')
    expect(text['src/c.ts']).toBe('import { userOf } from \'kay/library\'\nimport { defineContext } from \'kay/server\'\n\nexport default defineContext({})\n')
    expect(text['src/d.ts']).toContain('./mine')
  })
})

describe('deprecated-env-files', () => {
  it('renames env in kay.config.ts, and reports a clash with no fix', async () => {
    const { found, text } = await fixed({ 'kay.config.ts': 'export default { env: { compose: \'c.yaml\' } }\n', 'src/other.ts': 'export default { env: false }\n' }, envFiles)

    expect(found).toHaveLength(1)
    expect(text['kay.config.ts']).toBe('export default { envFiles: { compose: \'c.yaml\' } }\n')
    expect(text['src/other.ts']).toContain('env: false')

    const clash = await fixed({ 'kay.config.ts': 'export default { env: false, envFiles: true }\n' }, envFiles)

    expect(clash.found).toHaveLength(1)
    expect(clash.text['kay.config.ts']).toContain('env: false')
  })
})
