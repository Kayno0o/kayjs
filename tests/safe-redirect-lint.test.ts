import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check/fixes'
import { safeRedirects } from '../src/check/safe-redirect'
import { scratchDir } from './scratch'

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('safe-redirect-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('deprecated-safe-redirect', () => {
  it('calls localPath with the fallback safeRedirect defaulted to, and swaps the import', async () => {
    const page = '--- server\nimport { safeRedirect } from \'@kaynooo/kayjs-auth\'\n\nconst next = safeRedirect(ctx.query.next)\nconst home = safeRedirect(ctx.query.next, \'/home\')\n---\np= next\n'
    const kept = 'import { createAuth, safeRedirect } from \'@kaynooo/kayjs-auth\'\n\nexport const a = (value: unknown) => safeRedirect(value,)\n'
    const already = 'import { localPath } from \'kay\'\nimport { safeRedirect } from \'@kaynooo/kayjs-auth\'\n\nexport const b = (value: unknown) => [localPath(value, \'/\'), safeRedirect(value)]\n'
    const root = await project({ 'src/routes/index.kay': page, 'src/kept.ts': kept, 'src/already.ts': already })

    try {
      const found = await safeRedirects(root, {})

      expect(found).toHaveLength(4)
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/routes/index.kay')).text()).toBe('--- server\nimport { localPath } from \'kay\'\n\nconst next = localPath(ctx.query.next, \'/\')\nconst home = localPath(ctx.query.next, \'/home\')\n---\np= next\n')
      expect(await Bun.file(join(root, 'src/kept.ts')).text()).toBe('import { localPath } from \'kay\'\nimport { createAuth } from \'@kaynooo/kayjs-auth\'\n\nexport const a = (value: unknown) => localPath(value, \'/\',)\n')
      expect(await Bun.file(join(root, 'src/already.ts')).text()).toBe('import { localPath } from \'kay\'\n\nexport const b = (value: unknown) => [localPath(value, \'/\'), localPath(value, \'/\')]\n')
      expect(await safeRedirects(root, {})).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports with no fix a fallback that is no literal, a value read, and leaves other safeRedirect alone', async () => {
    const module = 'import { safeRedirect } from \'@kaynooo/kayjs-auth\'\n\nexport const a = (value: unknown, home: string) => safeRedirect(value, home)\nexport const b = [1].map(safeRedirect)\n'
    const own = 'import { safeRedirect } from \'./mine\'\n\nexport const c = safeRedirect(1)\n// kay-allow deprecated-safe-redirect\nexport const d = 1\n'
    const root = await project({ 'src/a.ts': module, 'src/own.ts': own })

    try {
      const found = await safeRedirects(root, {})

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.fixes]).sort()).toEqual([['src/a.ts', undefined]])
      await applySafeFixes(root, found)
      expect(await Bun.file(join(root, 'src/a.ts')).text()).toBe(module)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
