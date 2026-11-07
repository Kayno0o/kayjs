import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { hookNames } from '../src/check/hook-names'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('hook-names-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

const AUTH = 'import { auth } from \'@kaynooo/kayjs-auth\'\n'

describe('deprecated-hook-names', () => {
  it('renames the hooks of kayjs-auth in its calls and in src/auth.ts, and leaves what is not theirs', async () => {
    const call = `${AUTH}\nexport default auth({ onAuthEvent: info => console.log(info.event), onDelete: ({ user }) => erase(user) })\n`
    const core = 'import { authCore as core } from \'@kaynooo/kayjs-auth\'\n\nexport const made = core({ onDelete() {}, \'onAuthEvent\': log })\n'
    const namespaced = 'import * as kayjs from \'@kaynooo/kayjs-auth\'\n\nexport const made = kayjs.auth({ onAuthEvent: log })\n'
    const shorthand = `${AUTH}\nconst onDelete = () => {}\n\nexport const made = auth({ onDelete })\n`
    const fence = `--- server\n${AUTH}\nexport const made = auth({ onDelete: () => {} })\n---\np x\n`
    const hooks = 'import type { AuthHooks } from \'@kaynooo/kayjs-auth\'\n\nexport const hooks = { onAuthEvent: log, onDelete: erase } satisfies AuthHooks\n'
    const clash = `${AUTH}\nexport const made = auth({ onDelete: erase, beforeDelete: check })\n`
    const mine = 'import { auth } from \'./mine\'\nimport { t } from \'pg-orm\'\n\nexport const made = auth({ onDelete: erase })\nexport const column = t.text().references(users, \'id\', { onDelete: \'cascade\' })\nexport const hooks = { onDelete: erase }\n'
    const root = await project({ 'src/call.ts': call, 'src/core.ts': core, 'src/namespaced.ts': namespaced, 'src/shorthand.ts': shorthand, 'src/routes/fence.kay': fence, 'src/auth.ts': hooks, 'src/clash.ts': clash, 'src/mine.ts': mine, 'src/other/auth.ts': 'export const hooks = { onDelete: erase }\n' })

    try {
      const found = await hookNames(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.line, diagnostic.fixes === undefined]).sort()).toEqual([
        ['src/auth.ts', 3, false],
        ['src/auth.ts', 3, false],
        ['src/call.ts', 3, false],
        ['src/call.ts', 3, false],
        ['src/clash.ts', 3, true],
        ['src/core.ts', 3, false],
        ['src/core.ts', 3, false],
        ['src/namespaced.ts', 3, false],
        ['src/routes/fence.kay', 4, false],
        ['src/shorthand.ts', 5, false],
      ].sort())

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/call.ts')).text()).toBe(call.replace('onAuthEvent', 'onEvent').replace('onDelete', 'beforeDelete'))
      expect(await Bun.file(join(root, 'src/core.ts')).text()).toBe(core.replace('onDelete()', 'beforeDelete()').replace('\'onAuthEvent\'', '\'onEvent\''))
      expect(await Bun.file(join(root, 'src/namespaced.ts')).text()).toBe(namespaced.replace('onAuthEvent', 'onEvent'))
      expect(await Bun.file(join(root, 'src/shorthand.ts')).text()).toBe(shorthand.replace('auth({ onDelete })', 'auth({ beforeDelete: onDelete })'))
      expect(await Bun.file(join(root, 'src/routes/fence.kay')).text()).toBe(fence.replace('onDelete', 'beforeDelete'))
      expect(await Bun.file(join(root, 'src/auth.ts')).text()).toBe(hooks.replace('onAuthEvent', 'onEvent').replace('onDelete', 'beforeDelete'))
      expect(await Bun.file(join(root, 'src/clash.ts')).text()).toBe(clash)
      expect(await Bun.file(join(root, 'src/mine.ts')).text()).toBe(mine)
      expect((await hookNames(root, {})).map(diagnostic => diagnostic.file.slice(root.length + 1))).toEqual(['src/clash.ts'])
      expect(await hookNames(root, { lints: { 'deprecated-hook-names': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
