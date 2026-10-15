import { watch } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { takesControlCodes } from '../src/commands/command'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '../src/cli.ts')
const dirs: string[] = []
const COLOUR_ENV = new Set(['NO_COLOR', 'FORCE_COLOR', 'NODE_DISABLE_COLORS'])
const unformatted = '---  client\nconst a = 1\n---\np {a}\n'
const counter = '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {n()}\n'

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('quiet-')

  dirs.push(root)
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

// The environment of a pipe with no colour asked either way, the test runner's own taken off.
async function kay(args: string[], cwd: string, env: Record<string, string> = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !COLOUR_ENV.has(name)))
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: { ...inherited, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

describe('--quiet', () => {
  it('formats with one line for every file', async () => {
    const root = await project({ 'src/a.kay': unformatted, 'src/b.kay': unformatted, 'src/c.kay': 'p Fine\n' })
    const { stdout, stderr, code } = await kay(['fmt', 'src', '--quiet'], root)

    expect([stdout, stderr, code]).toEqual(['formatted 2 files\n', '', 0])
  })

  it('builds with its summary and none of the size report', async () => {
    const root = await project({
      'kay.config.ts': 'export default { favicon: false }\n',
      'src/counter.kay': counter,
      'src/routes/index.kay': '--- server\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
    })
    const { stdout, stderr, code } = await kay(['build', '.', '--no-check', '--quiet'], root)

    expect(code, stderr).toBe(0)
    expect(stdout).toMatch(/^built 1 island, 0 stylesheets and 0 prerendered pages in \d+ ms\n$/)
  }, 30_000)

  it('builds printing the size report, with no escape code in a pipe', async () => {
    const root = await project({
      'kay.config.ts': 'export default { favicon: false }\n',
      'src/counter.kay': counter,
      'src/routes/index.kay': '--- server\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
    })
    const { stdout, stderr, code } = await kay(['build', '.', '--no-check'], root)

    expect(code, stderr).toBe(0)
    expect(stdout).toContain('JavaScript, gzip (minified):')
    expect(stdout).toMatch(/^ {2}src\/counter\.kay +\+\d/m)
    expect(stdout).toMatch(/^Routes, gzip/m)
    // eslint-disable-next-line no-control-regex
    expect(stdout).not.toMatch(/\x1B/)
  }, 30_000)

  it('migrates listing what is left to do by hand, and not every file written', async () => {
    const root = await project({
      'package.json': '{ "dependencies": { "astro": "^5.0.0" } }',
      'src/pages/index.astro': '<h1>Home</h1>\n',
      'src/pages/about.astro': '<h1>About</h1>\n',
      'src/pages/api/ping.ts': 'export const GET = () => new Response(\'pong\')\n',
    })
    const { stdout, code } = await kay(['migrate', 'astro', '.', '--quiet'], root)

    expect(code).toBe(0)
    expect(stdout).not.toContain('wrote')
    expect(stdout).toContain('src/pages/api/ping.ts:1')
    expect(stdout.trimEnd().split('\n').at(-1)).toBe('2 files written, 2 items left to do by hand')
  })

  it('scaffolds with the line saying what it created, and not how to run it', async () => {
    const root = await project({})
    const created: string[] = []
    // Packing kay from this checkout writes nothing into it, which every other test type-checks and walks meanwhile.
    const watcher = watch(join(import.meta.dir, '..'), (_, name) => {
      if (name === 'types' || name === 'dist')
        created.push(name)
    })

    try {
      const { stdout, stderr, code } = await kay(['new', 'app', '-y', '--quiet'], root)

      expect(code, stderr).toBe(0)
      expect(stdout).toMatch(/^created app, [^\n]+ files\n$/)
      expect(created).toEqual([])
    }
    finally {
      watcher.close()
    }
  })

  it('is refused by a command whose output is its answer', async () => {
    const { code, stderr } = await kay(['explain', '--quiet'], process.cwd())

    expect(code).toBe(1)
    expect(stderr).toStartWith('kay: Unknown option \'--quiet\'')
  })
})

describe('colour and control codes', () => {
  it('are left out of a pipe, and put back with FORCE_COLOR', async () => {
    const root = await project({ 'src/a.kay': unformatted })

    expect((await kay(['fmt', 'src', '--check'], root)).stderr).toBe('not formatted: src/a.kay\n')
    expect((await kay(['fmt', 'src'], root)).stdout).toBe('formatted src/a.kay\n')

    await Bun.write(join(root, 'src/a.kay'), unformatted)

    expect((await kay(['fmt', 'src'], root, { FORCE_COLOR: '1' })).stdout).toContain('\x1B[32m')
  })

  it('are written to a terminal alone, never under NO_COLOR or on a dumb one', () => {
    expect(takesControlCodes({ isTTY: true }, {})).toBe(true)
    expect(takesControlCodes({ isTTY: false }, {})).toBe(false)
    expect(takesControlCodes({}, {})).toBe(false)
    expect(takesControlCodes({ isTTY: true }, { NO_COLOR: '1' })).toBe(false)
    expect(takesControlCodes({ isTTY: true }, { NODE_DISABLE_COLORS: '1' })).toBe(false)
    expect(takesControlCodes({ isTTY: true }, { TERM: 'dumb' })).toBe(false)
    // Colour is asked for, but a redrawn line or a cleared screen in a pipe would garble it still.
    expect(takesControlCodes({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(false)
  })
})
