import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { check } from '../src/check'
import { formatFiles } from '../src/format'
import { createProject } from '../src/new'
import { buildClient } from '../src/server/client'

const repo = join(import.meta.dir, '..')

// Stands in for `bun install`: the project sees this checkout as `kay` and its dependencies as its own.
async function linkDependencies(dir: string) {
  const modules = join(dir, 'node_modules')

  await mkdir(modules)
  await Promise.all((await readdir(join(repo, 'node_modules'))).map(async name => symlink(join(repo, 'node_modules', name), join(modules, name))))
  await symlink(repo, join(modules, 'kay'))
}

describe('kay new', () => {
  it('scaffolds a project that type-checks, is formatted and builds as it is', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')

    try {
      const files = await createProject(dir, { kay: '^1.0.0' })
      const manifest = await Bun.file(join(dir, 'package.json')).json() as { dependencies: Record<string, string> }

      expect(files).toContain('src/routes/index.kay')
      expect(manifest.dependencies.kay).toBe('^1.0.0')
      expect(await Bun.file(join(dir, 'src/routes/_layout.kay')).text()).toContain('title my-app')

      await linkDependencies(dir)
      expect(await check(dir)).toEqual([])
      expect((await formatFiles([join(dir, 'src')], { write: false })).changed).toEqual([])

      const client = await buildClient(dir)

      expect(Object.keys(client.islands)).toEqual(['src/components/counter.kay'])
      const stylesheet = client.styles.get(join(dir, 'src/routes/_layout.kay'))!

      expect(await Bun.file(join(client.dir, stylesheet.slice('/_kay/'.length))).text()).toContain('@view-transition')
    }
    finally {
      await rm(join(dir, '..'), { recursive: true, force: true })
    }
  })

  it('refuses a directory that already holds files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-new-'))

    try {
      await Bun.write(join(dir, 'keep.txt'), 'mine')
      await expect(createProject(dir)).rejects.toThrow('is not empty')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
