import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { actionType } from '../src/check/action-type'
import { applySafeFixes } from '../src/check/fixes'
import { liveApi } from '../src/check/live-api'
import { scratchDir } from './scratch'

async function fixed(check: typeof liveApi, files: Record<string, string>) {
  const root = await scratchDir('live-api-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  const found = await check(root, {})

  await applySafeFixes(root, found)

  return { root, found, read: async (path: string) => Bun.file(join(root, path)).text() }
}

const LIVE = 'import { live } from \'kay\'\n\nexport const room = live((id: string) => ({ id, users: 0 }))\nexport const unread = live(0, { user: true })\nexport const visitors = live(0)\nexport const tally = live(0, { key: true })\n'

describe('deprecated-live-api', () => {
  it('writes the key or the user of a set in its options, in the file declaring the value and in one importing it', async () => {
    const { root, found, read } = await fixed(liveApi, {
      'src/live.ts': `${LIVE}\nroom.set('lobby', { id: 'lobby', users: 1 })\nunread.set(user.id, n => n + 1)\ntally.set(id, 4)\nvisitors.set(2)\n`,
      'src/routes/page.kay': '--- server\nimport { room as rooms, unread, visitors } from \'../live\'\n\nconst id = \'a\'\nrooms.set(id, { id, users: 2 })\nunread.set(\'bob\', 3)\nvisitors.set(5)\n---\np Hi\n',
    })

    try {
      expect(found).toHaveLength(5)
      expect(found.every(one => one.code === 'deprecated-live-api' && one.fixes?.[0]?.safe === true)).toBe(true)
      expect(await read('src/live.ts')).toBe(`${LIVE}\nroom.set({ id: 'lobby', users: 1 }, { key: 'lobby' })\nunread.set(n => n + 1, { user: user.id })\ntally.set(4, { key: id })\nvisitors.set(2)\n`)
      expect(await read('src/routes/page.kay')).toBe('--- server\nimport { room as rooms, unread, visitors } from \'../live\'\n\nconst id = \'a\'\nrooms.set({ id, users: 2 }, { key: id })\nunread.set(3, { user: \'bob\' })\nvisitors.set(5)\n---\np Hi\n')
      expect(await liveApi(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves the new form, a plain value, a name no declaration agrees on and a spread alone', async () => {
    const { root, found, read } = await fixed(liveApi, {
      'src/live.ts': `${LIVE}\nroom.set({ id: 'a', users: 1 }, { key: 'a' })\nunread.set(1, { user })\nvisitors.set(1, 2)\nroom.set(...args)\n`,
      'src/other.ts': 'import { live } from \'kay\'\n\nexport const room = live(0)\n',
      'src/use.ts': 'import { room } from \'./live\'\n\nroom.set(\'a\', 1)\nother.set(\'a\', 1)\n',
    })

    try {
      expect(found).toEqual([])
      expect(await read('src/use.ts')).toContain('room.set(\'a\', 1)')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes the arguments of presence as one object, its options spread into it', async () => {
    const script = 'import { presence } from \'kay\'\n\nconst a = presence(\'lobby\')\nconst b = presence(room, member)\nconst c = presence(`entry:${id}`, { name }, { signal })\nconst d = presence(\'x\', null, options)\nconst e = presence({ room: \'y\' })\nconst f = presence()\n'
    const { root, found, read } = await fixed(liveApi, { 'src/script.ts': script, 'src/c.kay': '---\nimport { presence } from \'kay\'\n\nconst here = presence(room, me)\n---\np {here.count()}\n' })

    try {
      expect(found).toHaveLength(5)
      expect(found.filter(one => one.fixes === undefined)).toHaveLength(1)
      expect(await read('src/script.ts')).toBe('import { presence } from \'kay\'\n\nconst a = presence({ room: \'lobby\' })\nconst b = presence({ room, member })\nconst c = presence({ room: `entry:${id}`, member: { name }, signal })\nconst d = presence(\'x\', null, options)\nconst e = presence({ room: \'y\' })\nconst f = presence()\n')
      expect(await read('src/c.kay')).toContain('presence({ room, member: me })')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('deprecated-action-type', () => {
  it('drops the parameters of Action<never, unknown>, under any local name, in a script and a fence', async () => {
    const script = 'import type { Action as Any, Action as Plain } from \'kay\'\n\nexport type A = Any<never, unknown>\nexport type B = Plain<{ name: string }, string>\nexport type C = Any<never, unknown, \'hp\'>\n'
    const page = '---\nimport type { Action } from \'kay\'\n\nconst { run } = props<{ run: Action<never, unknown> }>()\n---\nform(action={run})\n  button Go\n'
    const { root, found, read } = await fixed(actionType, { 'src/types.ts': script, 'src/go.kay': page, 'src/other.ts': 'type Action<A, B> = A | B\nexport type X = Action<never, unknown>\n' })

    try {
      expect(found).toHaveLength(2)
      expect(found.every(one => one.code === 'deprecated-action-type' && one.fixes?.[0]?.safe === true)).toBe(true)
      expect(await read('src/types.ts')).toBe(script.replace('Any<never, unknown>;', 'Any;').replace('type A = Any<never, unknown>', 'type A = Any'))
      expect(await read('src/go.kay')).toContain('run: Action }>()')
      expect(await read('src/other.ts')).toContain('Action<never, unknown>')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
