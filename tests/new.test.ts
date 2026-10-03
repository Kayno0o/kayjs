import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { check } from '../src/check'
import { formatFiles } from '../src/format'
import { createProject } from '../src/new'
import { buildClient } from '../src/server/client'

const repo = join(import.meta.dir, '..')

// Stands in for `bun install` of a packed kay: its source and the declarations `prepack` emits, beside this checkout's dependencies.
async function installKay(dir: string) {
  const modules = join(dir, 'node_modules')
  const kay = join(modules, 'kay')

  await mkdir(kay, { recursive: true })
  await Promise.all([
    // The checkout's own `kay` is a link back to it, which the packed copy below replaces.
    ...(await readdir(join(repo, 'node_modules'))).filter(name => name !== 'kay').map(async name => symlink(join(repo, 'node_modules', name), join(modules, name))),
    ...['package.json', 'src'].map(async name => symlink(join(repo, name), join(kay, name))),
  ])

  const emit = Bun.spawn([join(repo, 'node_modules/.bin/tsgo'), '-p', join(repo, 'tsconfig.build.json'), '--outDir', join(kay, 'types')], { stdout: 'pipe', stderr: 'pipe' })

  expect(await emit.exited).toBe(0)
}

describe('kay new', () => {
  it('scaffolds a project that type-checks against the declarations of kay, is formatted and builds as it is', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')

    try {
      const files = await createProject(dir, { kay: '^1.0.0' })
      const manifest = await Bun.file(join(dir, 'package.json')).json() as { dependencies: Record<string, string> }

      expect(files).toContain('src/routes/index.kay')
      expect(await Bun.file(join(dir, '.npmrc')).text()).toBe('@kaynooo:registry=https://git.kaynooo.fr/api/packages/kaynooo/npm/\n')
      expect(manifest.dependencies.kay).toBe('^1.0.0')
      expect(await Bun.file(join(dir, 'src/routes/_layout.kay')).text()).toContain('title my-app')

      await installKay(dir)

      // Stricter than kay itself: its source fails this flag, its declarations must not.
      const tsconfig = await Bun.file(join(dir, 'tsconfig.json')).json() as { compilerOptions: Record<string, unknown> }

      await Bun.write(join(dir, 'tsconfig.json'), JSON.stringify({ ...tsconfig, compilerOptions: { ...tsconfig.compilerOptions, exactOptionalPropertyTypes: true } }))
      expect(await check(dir)).toEqual([])
      expect((await formatFiles([join(dir, 'src')], { write: false })).changed).toEqual([])

      const tests = Bun.spawn([process.execPath, 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
      const [report, code] = await Promise.all([new Response(tests.stderr).text(), tests.exited])

      expect(report).toContain('1 pass')
      expect(code).toBe(0)

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
