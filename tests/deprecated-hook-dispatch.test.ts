import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { hookDispatch } from '../src/check/renamed-exports'
import { scratchDir } from './scratch'

describe('deprecated-hook-dispatch', () => {
  it('renames notify and NotifyOptions of kay/library, and leaves the inbox of kay/server alone', async () => {
    const library = 'import type { NotifyOptions } from \'kay/library\'\nimport { notify } from \'kay/library\'\n\nexport const options: NotifyOptions = { detached: true }\nexport const tell = () => notify(\'app.onSave\', [], {}, options)\n'
    const inbox = 'import { notify } from \'kay/server\'\n\nexport const tell = () => notify(\'ada\', { title: \'x\' })\n'
    const root = await scratchDir('hook-dispatch-')

    await Bun.write(join(root, 'src/library.ts'), library)
    await Bun.write(join(root, 'src/inbox.ts'), inbox)

    try {
      const found = await hookDispatch(root, {})

      expect(found.map(one => one.file.slice(root.length + 1)).sort()).toEqual(['src/library.ts', 'src/library.ts'])
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/library.ts')).text()).toBe(library.replaceAll('NotifyOptions', 'DispatchOptions').replaceAll('notify', 'dispatch'))
      expect(await Bun.file(join(root, 'src/inbox.ts')).text()).toBe(inbox)
      expect(await hookDispatch(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
