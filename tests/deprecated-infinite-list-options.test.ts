import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { infiniteListOptions } from '../src/check/infinite-list-options'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('infinite-list-options-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-infinite-list-options', () => {
  it('renames pageSize in the options of infiniteList(), shorthands included', async () => {
    const script = 'import { infiniteList } from \'@kaynooo/kayjs-ui\'\nimport * as ui from \'@kaynooo/kayjs-ui\'\n\nconst pageSize = 20\n\ninfiniteList([], { pageSize: 10, load: () => [] })\nui.infiniteList([], { pageSize, load: () => [] })\n'
    const page = '---\nimport { infiniteList } from \'@kaynooo/kayjs-ui\'\n\nconst feed = infiniteList([], { pageSize: 5, load: () => [] })\n---\np hi\n'
    const root = await project({ 'src/feed.ts': script, 'src/routes/page.kay': page })

    try {
      const found = await infiniteListOptions(root, {})

      expect(found).toHaveLength(3)
      expect(found.every(one => one.code === 'deprecated-infinite-list-options')).toBe(true)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/feed.ts')).text()).toContain('infiniteList([], { limit: 10, load: () => [] })')
      expect(await Bun.file(join(root, 'src/feed.ts')).text()).toContain('ui.infiniteList([], { limit: pageSize, load: () => [] })')
      expect(await Bun.file(join(root, 'src/routes/page.kay')).text()).toBe(page.replace('pageSize:', 'limit:'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a key beside its new name with no fix, and leaves other functions alone', async () => {
    const script = 'import { infiniteList } from \'@kaynooo/kayjs-ui\'\nimport { infiniteList as mine } from \'./mine\'\n\ninfiniteList([], { pageSize: 10, limit: 10, load: () => [] })\nmine([], { pageSize: 10 })\ninfiniteList([], { limit: 10, load: () => [] })\n'
    const root = await project({ 'src/feed.ts': script })

    try {
      const found = await infiniteListOptions(root, {})

      expect(found).toHaveLength(1)
      expect(found[0]!.fixes).toBeUndefined()
      expect(await infiniteListOptions(root, { lints: { 'deprecated-infinite-list-options': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
