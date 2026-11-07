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

      // `onDelete` changes what it does under its new name, so its fix is not a safe one.
      expect(found.filter(diagnostic => diagnostic.fixes?.[0]?.safe === false).map(diagnostic => diagnostic.file.slice(root.length + 1)).sort()).toEqual(['src/auth.ts', 'src/call.ts', 'src/core.ts', 'src/routes/fence.kay', 'src/shorthand.ts'])

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/call.ts')).text()).toBe(call.replace('onAuthEvent', 'onEvent'))
      expect(await Bun.file(join(root, 'src/core.ts')).text()).toBe(core.replace('\'onAuthEvent\'', '\'onEvent\''))
      expect(await Bun.file(join(root, 'src/namespaced.ts')).text()).toBe(namespaced.replace('onAuthEvent', 'onEvent'))
      expect(await Bun.file(join(root, 'src/shorthand.ts')).text()).toBe(shorthand)
      expect(await Bun.file(join(root, 'src/routes/fence.kay')).text()).toBe(fence)
      expect(await Bun.file(join(root, 'src/auth.ts')).text()).toBe(hooks.replace('onAuthEvent', 'onEvent'))
      expect(await Bun.file(join(root, 'src/clash.ts')).text()).toBe(clash)
      expect(await Bun.file(join(root, 'src/mine.ts')).text()).toBe(mine)
      expect((await hookNames(root, {})).map(diagnostic => diagnostic.file.slice(root.length + 1)).sort()).toEqual(['src/auth.ts', 'src/call.ts', 'src/clash.ts', 'src/core.ts', 'src/routes/fence.kay', 'src/shorthand.ts'])
      expect(await hookNames(root, { lints: { 'deprecated-hook-names': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

const AI = 'import { ai, ask } from \'@kaynooo/kayjs-ai\'\n'

describe('deprecated-hook-names for kayjs-ai', () => {
  it('renames onRequest and onFinish, wraps the argument of onError, and leaves what is not ai\'s', async () => {
    const call = `${AI}\nai({ onRequest: ({ messages }) => ({ messages }), onFinish: done => bill(done), onError: error => report(error) })\nawait ask('hi', { onFinish: log, onError: function (e) { report(e) } })\n`
    const named = `${AI}\nai({ onError: error => report(error), onRequest() {} })\n`
    const namespaced = 'import * as kayjs from \'@kaynooo/kayjs-ai\'\n\nkayjs.ask(\'hi\', { onFinish: log })\n'
    const fresh = `${AI}\nai({ beforeRequest: check, onSuccess: log, onError: ({ error }) => report(error), onError2: 1 })\nai({ onError: () => alert() })\n`
    const reference = `${AI}\nai({ onError: report })\n`
    const typed = `${AI}\nai({ onError: (error: unknown) => report(error) })\n`
    const clash = `${AI}\nai({ onRequest: old, beforeRequest: next })\n`
    const mine = 'import { ai, ask } from \'./mine\'\n\nai({ onRequest: check, onFinish: log, onError: report })\nask(\'hi\', { onFinish: log })\n'
    const root = await project({ 'src/call.ts': call, 'src/named.ts': named, 'src/namespaced.ts': namespaced, 'src/fresh.ts': fresh, 'src/reference.ts': reference, 'src/typed.ts': typed, 'src/clash.ts': clash, 'src/mine.ts': mine })

    try {
      const found = await hookNames(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.line, diagnostic.fixes === undefined]).sort()).toEqual([
        ['src/call.ts', 3, false],
        ['src/call.ts', 3, false],
        ['src/call.ts', 3, false],
        ['src/call.ts', 4, false],
        ['src/call.ts', 4, false],
        ['src/clash.ts', 3, true],
        ['src/named.ts', 3, false],
        ['src/named.ts', 3, false],
        ['src/namespaced.ts', 3, false],
        ['src/reference.ts', 3, true],
        ['src/typed.ts', 3, true],
      ].sort())

      // Every rename keeps what the hook does, so every fix is a safe one.
      expect(found.every(diagnostic => diagnostic.fixes === undefined || diagnostic.fixes[0]?.safe !== false)).toBe(true)

      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/call.ts')).text()).toBe(`${AI}\nai({ beforeRequest: ({ messages }) => ({ messages }), onSuccess: done => bill(done), onError: ({ error }) => report(error) })\nawait ask('hi', { onSuccess: log, onError: function ({ error: e }) { report(e) } })\n`)
      expect(await Bun.file(join(root, 'src/named.ts')).text()).toBe(`${AI}\nai({ onError: ({ error }) => report(error), beforeRequest() {} })\n`)
      expect(await Bun.file(join(root, 'src/namespaced.ts')).text()).toBe(namespaced.replace('onFinish', 'onSuccess'))
      expect(await Bun.file(join(root, 'src/fresh.ts')).text()).toBe(fresh)
      expect(await Bun.file(join(root, 'src/reference.ts')).text()).toBe(reference)
      expect(await Bun.file(join(root, 'src/typed.ts')).text()).toBe(typed)
      expect(await Bun.file(join(root, 'src/clash.ts')).text()).toBe(clash)
      expect(await Bun.file(join(root, 'src/mine.ts')).text()).toBe(mine)
      expect((await hookNames(root, {})).map(diagnostic => diagnostic.file.slice(root.length + 1)).sort()).toEqual(['src/clash.ts', 'src/reference.ts', 'src/typed.ts'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
