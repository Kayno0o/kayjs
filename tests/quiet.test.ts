import { watch } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
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
    expect(stdout).toMatch(/^built 1 island, 0 stylesheets and 1 prerendered page in \d+ ms\n$/)
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

      // The declaration maps point at the sources the package ships, as prepack's do, not at this checkout.
      const [tarball] = await readdir(join(root, 'app/vendor'))
      const map = Bun.spawnSync(['tar', '-xzOf', join(root, 'app/vendor', tarball!), 'package/types/bun.d.ts.map']).stdout.toString()

      expect((JSON.parse(map) as { sources: string[] }).sources).toEqual(['../src/bun.ts'])
    }
    finally {
      watcher.close()
    }
  })

  it('is refused by a command whose output is its answer', async () => {
    const { code, stderr } = await kay(['explain', '--quiet'], process.cwd())

    expect(code).toBe(1)
    expect(stderr).toStartWith('kay explain: unknown option --quiet\nUsage: kay explain [lint|error|group]')
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

describe('usage on a refusal', () => {
  it('is the command\'s own line alone, both words for a subcommand', async () => {
    const root = await project({})
    const build = await kay(['build', '--bogus'], root)
    const missing = await kay(['i18n', 'missing', '--bogus'], root)
    const extra = await kay(['upgrade', 'a', 'b'], root)

    expect(build.code).toBe(1)
    expect(build.stderr).toStartWith('kay build: unknown option --bogus\nUsage: kay build [dir]')
    expect(build.stderr).not.toContain('kay start')
    expect(build.stderr).not.toContain('--\' ')
    expect(build.stderr.trimEnd().split('\n')).toHaveLength(2)
    expect(missing.stderr).toBe('kay i18n missing: unknown option --bogus\nUsage: kay i18n missing [locale] [dir] [--format text|json]\n')
    expect(extra.stderr).toBe('kay: unexpected argument b\nUsage: kay upgrade [dir] [--dry-run] [--quiet]\n')
  })

  it('names a near option, and prints that command alone for --help', async () => {
    const root = await project({})
    const typo = await kay(['build', '--no-chek'], root)
    const help = await kay(['build', '--help'], root)

    expect(typo.stderr).toStartWith('kay build: unknown option --no-chek, did you mean --no-check?\n')
    expect(help.code).toBe(0)
    expect(help.stdout).toStartWith('Usage: kay build [dir]')
    expect(help.stdout).toContain('[--no-cache]')
    expect(help.stdout.trimEnd().split('\n')).toHaveLength(1)
  })

  it('stays every command for kay --help and an unknown command', async () => {
    const root = await project({})
    const help = await kay(['--help'], root)
    const unknown = await kay(['bogus'], root)

    expect(help.stdout).toContain('kay build')
    expect(help.stdout).toContain('kay mcp')
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('kay start')
    expect(unknown.stderr).toContain('kay mcp')
  })
})
