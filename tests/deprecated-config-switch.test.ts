import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { configSwitches } from '../src/check/config-switches'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function fixed(files: Record<string, string>): Promise<{ text: Record<string, string>, found: Awaited<ReturnType<typeof configSwitches>> }> {
  const root = await scratchDir('config-switch-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const found = await configSwitches(root, {})

    await applySafeFixes(root, found)

    return { found, text: Object.fromEntries(await Promise.all(Object.keys(files).map(async path => [path, await Bun.file(join(root, path)).text()]))) }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('deprecated-config-switch', () => {
  it('writes a proxy count as `true` for one and `{ hops }` for more', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'export default { proxy: 2, lang: \'en\' }\n',
      'one/kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ proxy: 1 })\n',
    })

    expect(found).toHaveLength(2)
    expect(text['kay.config.ts']).toBe('export default { proxy: { hops: 2 }, lang: \'en\' }\n')
    expect(text['one/kay.config.ts']).toBe('import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ proxy: true })\n')
  })

  it('leaves the new forms, other files and other keys alone, and reports a count no fix can write', async () => {
    const { found, text } = await fixed({
      'kay.config.ts': 'export default { proxy: true }\n',
      'a/kay.config.ts': 'export default { proxy: { hops: 2 } }\n',
      'src/other.ts': 'export default { proxy: 2 }\n',
      'b/kay.config.ts': 'export default { proxy: 0 }\n',
      'c/kay.config.ts': 'export default { serve: { proxy: 2 } }\n',
    })

    expect(found).toHaveLength(1)
    expect(found[0]?.fixes).toBeUndefined()
    expect(text['src/other.ts']).toBe('export default { proxy: 2 }\n')
    expect(text['b/kay.config.ts']).toBe('export default { proxy: 0 }\n')
    expect(text['c/kay.config.ts']).toBe('export default { serve: { proxy: 2 } }\n')
  })
})
