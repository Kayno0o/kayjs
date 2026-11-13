import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { uiItemKeys } from '../src/check/ui-items'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('ui-item-keys-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-ui-item-keys', () => {
  const imports = '---\nimport TreeView from \'@kaynooo/kayjs-ui/tree-view.kay\'\nimport Bell from \'@kaynooo/kayjs-ui/bell.kay\'\nimport BellInbox from \'@kaynooo/kayjs-ui/bell-inbox.kay\'\n'

  it('renames tree nodes at every depth and the notifications of a Bell, one bound to a const included', async () => {
    const page = `${imports}const notes = [{ id: 'n', title: 'Hi', url: '/hi' }]\nconst id = 'x'\n---\nTreeView(label="Files" nodes={[{ id: 'a', label: 'A', children: [{ id, label: 'X', children: [{ id: 'deep', label: 'Deep' }] }] }]})\nBell(items={notes})\nBellInbox(items={[{ id: 'm', title: 'Yo', read: true }]})\n`
    const root = await project({ 'src/routes/page.kay': page })

    try {
      const found = await uiItemKeys(root, {})

      expect(found).toHaveLength(8)
      expect(found.every(one => one.code === 'deprecated-ui-item-keys' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)

      const fixed = await Bun.file(join(root, 'src/routes/page.kay')).text()

      expect(fixed).toContain('nodes={[{ key: \'a\', label: \'A\', children: [{ key: id, label: \'X\', children: [{ key: \'deep\', label: \'Deep\' }] }] }]}')
      expect(fixed).toContain('const notes = [{ key: \'n\', label: \'Hi\', href: \'/hi\' }]')
      expect(fixed).toContain('items={[{ key: \'m\', label: \'Yo\', read: true }]}')
      expect(await uiItemKeys(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a node holding the new key with no fix, and leaves other components and an allowed level alone', async () => {
    const both = `${imports}---\nTreeView(label="Files" nodes={[{ key: 'a', id: 'b', label: 'A' }]})\n`
    const other = `${imports}---\nMenu(items={[{ id: 'a', title: 'A' }]})\nTreeView(label="Files" nodes={nodes})\n`
    const root = await project({ 'src/routes/a.kay': both, 'src/routes/b.kay': other })

    try {
      const found = await uiItemKeys(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]!.fixes).toBeUndefined()
      expect(await uiItemKeys(root, { lints: { 'deprecated-ui-item-keys': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
