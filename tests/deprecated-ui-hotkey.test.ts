import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { uiHotkey } from '../src/check/ui-hotkey'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('ui-hotkey-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

const HEAD = '---\nimport Toaster from \'@kaynooo/kayjs-ui/toaster.kay\'\nimport CommandPalette from \'@kaynooo/kayjs-ui/command-palette.kay\'\n---\n'

describe('deprecated-ui-hotkey', () => {
  it('writes the full chord for a literal key, Alt for a Toaster and Ctrl or Cmd for a CommandPalette, and keeps off as null', async () => {
    const page = `${HEAD}Toaster(hotkey="j" position="top-left")\nCommandPalette(entries={[]} hotkey='p')\nCommandPalette(entries={[]} hotkey={null})\nToaster(hotkey="")\n`
    const root = await project({ 'src/routes/page.kay': page })

    try {
      const found = await uiHotkey(root, {})

      expect(found).toHaveLength(4)
      expect(found.every(one => one.code === 'deprecated-ui-hotkey' && one.fixes?.[0]?.safe === true)).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/routes/page.kay')).text()).toBe(`${HEAD}Toaster(shortcut="alt+j" position="top-left")\nCommandPalette(entries={[]} shortcut="mod+p")\nCommandPalette(entries={[]} shortcut={null})\nToaster(shortcut={null})\n`)
      expect(await uiHotkey(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a computed hotkey with no fix, and leaves other components and files without kayjs-ui alone', async () => {
    const computed = `${HEAD}Toaster(hotkey={key})\n`
    const other = '---\nimport Menu from \'./menu.kay\'\n---\nMenu(hotkey="j")\n'
    const unrelated = '---\nimport Toaster from \'./toaster.kay\'\n---\nToaster(hotkey="j")\n'
    const root = await project({ 'src/routes/a.kay': computed, 'src/routes/b.kay': `${HEAD}Menu(hotkey="j")\n${other}`, 'src/routes/c.kay': unrelated })

    try {
      const found = await uiHotkey(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]!.fixes).toBeUndefined()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
