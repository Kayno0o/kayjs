import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { deprecatedAuthOptions } from '../src/check/deprecated-auth-options'
import { applySafeFixes } from '../src/check/fixes'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('auth-options-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-auth-options', () => {
  it('drops a default-on feature written true from auth() and createAuth(), and leaves what is not the library\'s', async () => {
    const config = 'import { auth } from \'@kaynooo/kayjs-auth/pages\'\n\nauth({\n  password: true,\n  // kept\n  twoFactor: { require: \'admin\' },\n  signUp: true, // open\n  magicLink: false,\n  pages: true,\n})\nauth({ password: true, oauthServer: true })\n'
    const plain = 'import { createAuth } from \'@kaynooo/kayjs-auth\'\n\nexport const a = createAuth({ store, sessions, twoFactor: true, pages: true })\nexport const b = createAuth({ signUp: true, store })\n'
    const own = 'import { auth } from \'./mine\'\n\nauth({ password: true })\n'
    const fence = '--- server\nimport { auth } from \'@kaynooo/kayjs-auth/pages\'\nexport const a = auth({ magicLink: true })\n---\np x\n'
    const root = await project({ 'kay.config.ts': config, 'src/plain.ts': plain, 'src/own.ts': own, 'src/routes/fence.kay': fence })

    try {
      const found = await deprecatedAuthOptions(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.line]).sort()).toEqual([
        ['kay.config.ts', 11],
        ['kay.config.ts', 4],
        ['kay.config.ts', 7],
        ['kay.config.ts', 9],
        ['src/plain.ts', 3],
        ['src/plain.ts', 4],
        ['src/routes/fence.kay', 3],
      ])

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe('import { auth } from \'@kaynooo/kayjs-auth/pages\'\n\nauth({\n  // kept\n  twoFactor: { require: \'admin\' },\n  magicLink: false,\n})\nauth({ oauthServer: true })\n')
      expect(await Bun.file(join(root, 'src/plain.ts')).text()).toBe('import { createAuth } from \'@kaynooo/kayjs-auth\'\n\nexport const a = createAuth({ store, sessions, pages: true })\nexport const b = createAuth({ store })\n')
      expect(await Bun.file(join(root, 'src/own.ts')).text()).toBe(own)
      expect(await Bun.file(join(root, 'src/routes/fence.kay')).text()).toBe('--- server\nimport { auth } from \'@kaynooo/kayjs-auth/pages\'\nexport const a = auth({  })\n---\np x\n')
      expect(await deprecatedAuthOptions(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stays quiet at allow', async () => {
    const root = await project({ 'kay.config.ts': 'import { auth } from \'@kaynooo/kayjs-auth/pages\'\nauth({ password: true })\n' })

    try {
      expect(await deprecatedAuthOptions(root, { lints: { 'deprecated-auth-options': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
