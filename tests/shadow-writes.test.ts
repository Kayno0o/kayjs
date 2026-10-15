import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { writeShadowTypes } from '../src/check'
import { scratchDir } from './scratch'

// The modification time of every file under `dir`.
async function stamps(dir: string): Promise<Map<string, number>> {
  const files = (await readdir(dir, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())

  return new Map(await Promise.all(files.map(async entry => [join(entry.parentPath, entry.name), (await stat(join(entry.parentPath, entry.name))).mtimeMs] as const)))
}

describe('writing the shadow tree again', () => {
  it('rewrites the one shadow whose .kay file changed', async () => {
    const root = await scratchDir('shadow-writes-')

    await Promise.all([
      Bun.write(join(root, 'tsconfig.json'), '{}\n'),
      Bun.write(join(root, 'src/routes/index.kay'), 'p Home\n'),
      Bun.write(join(root, 'src/routes/about.kay'), 'p About\n'),
      Bun.write(join(root, 'src/routes/blog/post.kay'), 'p Post\n'),
    ])
    await writeShadowTypes(root)
    await Bun.sleep(20)

    const types = join(root, '.kay/types')
    const before = await stamps(types)

    await Bun.write(join(root, 'src/routes/about.kay'), 'p About us\n')
    await writeShadowTypes(root)

    const after = await stamps(types)
    const rewritten = [...after].filter(([file, time]) => before.get(file) !== time).map(([file]) => file.slice(types.length + 1))

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    expect(rewritten).toEqual(['src/routes/about.kay.tsx'])
  })
})
