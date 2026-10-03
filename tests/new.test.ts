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

async function kay(args: string[], cwd?: string): Promise<{ stdout: string, stderr: string, code: number }> {
  const child = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

describe('kay command line', () => {
  it('prints the usage for --help and -h on every command, without running it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))

    try {
      for (const args of [['--help'], ['-h'], ['build', '--help'], ['check', '-h'], ['new', '--help'], ['fmt', '--help'], ['dev', '--help'], ['lsp', '--help']]) {
        const { stdout, stderr, code } = await kay(args, dir)

        expect({ args, stdout: stdout.startsWith('Usage: kay new'), stderr, code }).toEqual({ args, stdout: true, stderr: '', code: 0 })
      }

      expect(await readdir(dir)).toEqual([])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses an option or an argument a command does not take, with the usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))

    try {
      for (const args of [['new', '--bogus', 'app'], ['fmt', '--bogus'], ['build', '--bogus'], ['check', '--bogus'], ['dev', '--bogus'], ['build', 'a', 'b'], ['check', '-p'], ['new', 'a', 'b']]) {
        const { stdout, stderr, code } = await kay(args, dir)

        expect({ args, stdout, usage: stderr.includes('Usage: kay new'), code }).toEqual({ args, stdout: '', usage: true, code: 1 })
      }

      expect(await readdir(dir)).toEqual([])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a missing or non-.kay path of kay fmt, without a stack and without touching the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))

    try {
      await Bun.write(join(dir, 'notes.txt'), 'ul\n    li One\n')

      expect(await kay(['fmt', 'notes.txt'], dir)).toEqual({ stdout: '', stderr: 'kay fmt: notes.txt is not a .kay file\n', code: 1 })
      expect(await kay(['fmt', 'nope.kay'], dir)).toEqual({ stdout: '', stderr: 'kay fmt: nope.kay does not exist\n', code: 1 })
      expect(await Bun.file(join(dir, 'notes.txt')).text()).toBe('ul\n    li One\n')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('scaffolds a directory name holding spaces and braces as a valid package, a literal title and a quoted cd line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))

    try {
      const { stderr, code } = await kay(['new', 'my app {x}', '--kay', '^1.0.0'], dir)
      const manifest = await Bun.file(join(dir, 'my app {x}/package.json')).json() as { name: string }

      expect(code).toBe(0)
      expect(manifest.name).toBe('my-app-x')
      expect(await Bun.file(join(dir, 'my app {x}/src/routes/_layout.kay')).text()).toContain('title my-app-x\n')
      expect(stderr).toContain('cd \'my app {x}\' && bun install')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses to scaffold over a file with a message', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))

    try {
      await Bun.write(join(dir, 'afile'), 'x')

      expect(await kay(['new', 'afile'], dir)).toEqual({ stdout: '', stderr: 'kay: afile is not a directory\n', code: 1 })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

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
