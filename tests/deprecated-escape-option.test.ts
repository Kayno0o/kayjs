import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { deprecatedEscapeOption } from '../src/check/deprecated-escape-option'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('escape-option-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-escape-option', () => {
  it('renames plugin: false of auth() to server: false, and leaves what is not the library\'s', async () => {
    const config = 'import { auth } from \'@kaynooo/kayjs-auth/pages\'\n\nauth({ plugin: false, prefix: \'/a\' })\n'
    const namespaced = 'import * as lib from \'@kaynooo/kayjs-auth\'\n\nlib.auth({ plugin: false })\n'
    const clash = 'import { auth } from \'@kaynooo/kayjs-auth\'\n\nauth({ plugin: false, server: false })\n'
    const own = 'import { auth } from \'./mine\'\n\nauth({ plugin: false })\n'
    const other = 'import { auth } from \'@kaynooo/kayjs-auth\'\n\nauth({ plugin: true })\nauth({ server: false })\n'
    const root = await project({ 'kay.config.ts': config, 'src/namespaced.ts': namespaced, 'src/clash.ts': clash, 'src/own.ts': own, 'src/other.ts': other })

    try {
      const found = await deprecatedEscapeOption(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.line, diagnostic.fixes === undefined]).sort()).toEqual([
        ['kay.config.ts', 3, false],
        ['src/clash.ts', 3, true],
        ['src/namespaced.ts', 3, false],
      ])

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe(config.replace('plugin', 'server'))
      expect(await Bun.file(join(root, 'src/namespaced.ts')).text()).toBe(namespaced.replace('plugin', 'server'))
      expect(await Bun.file(join(root, 'src/clash.ts')).text()).toBe(clash)
      expect(await Bun.file(join(root, 'src/own.ts')).text()).toBe(own)
      expect(await Bun.file(join(root, 'src/other.ts')).text()).toBe(other)
      expect((await deprecatedEscapeOption(root, {})).map(diagnostic => diagnostic.file.slice(root.length + 1))).toEqual(['src/clash.ts'])
      expect(await deprecatedEscapeOption(root, { lints: { 'deprecated-escape-option': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('drops plugin beside a module, which server would be refused with, and gives no fix next to a spread', async () => {
    const before = 'import { auth } from \'@kaynooo/kayjs-auth\'\n\nauth({ plugin: false, module: \'./src/auth\' })\n'
    const after = 'import { auth } from \'@kaynooo/kayjs-auth\'\n\nauth({ module: \'./src/auth\', plugin: false })\n'
    const spread = 'import { auth } from \'@kaynooo/kayjs-auth\'\n\nauth({ ...base, plugin: false })\n'
    const root = await project({ 'src/before.ts': before, 'src/after.ts': after, 'src/spread.ts': spread })

    try {
      const found = await deprecatedEscapeOption(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.fixes === undefined]).sort()).toEqual([['src/after.ts', false], ['src/before.ts', false], ['src/spread.ts', true]])
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/before.ts')).text()).toBe('import { auth } from \'@kaynooo/kayjs-auth\'\n\nauth({ module: \'./src/auth\' })\n')
      expect(await Bun.file(join(root, 'src/after.ts')).text()).toBe('import { auth } from \'@kaynooo/kayjs-auth\'\n\nauth({ module: \'./src/auth\' })\n')
      expect(await Bun.file(join(root, 'src/spread.ts')).text()).toBe(spread)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renames a quoted key, an aliased import and a call in a .kay fence', async () => {
    const quoted = 'import { auth } from \'@kaynooo/kayjs-auth\'\n\nauth({ \'plugin\': false })\n'
    const aliased = 'import { auth as a } from \'@kaynooo/kayjs-auth/pages\'\n\na({ plugin: false })\n'
    const fence = '--- server\nimport { auth } from \'@kaynooo/kayjs-auth\'\nexport const x = auth({ plugin: false })\n---\np x\n'
    const root = await project({ 'src/quoted.ts': quoted, 'src/aliased.ts': aliased, 'src/routes/fence.kay': fence })

    try {
      await applySafeFixes(root, await deprecatedEscapeOption(root, {}))
      expect(await Bun.file(join(root, 'src/quoted.ts')).text()).toBe(quoted.replace('\'plugin\'', 'server'))
      expect(await Bun.file(join(root, 'src/aliased.ts')).text()).toBe(aliased.replace('plugin', 'server'))
      expect(await Bun.file(join(root, 'src/routes/fence.kay')).text()).toBe(fence.replace('plugin', 'server'))
      expect(await deprecatedEscapeOption(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
