import { mkdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { verifyExecutable } from '../src/build/verify'
import { LINT_GROUPS, LINTS } from '../src/compiler/lints'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '../src/cli.ts')
const dirs: string[] = []
const counter = '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {n()}\n'
// A config writing to stdout as it loads, as an app's may, which a document on stdout must not take in.
const noisyConfig = 'console.log(\'loading the config\')\nprocess.stdout.write(\'written\\n\')\n\nexport default { favicon: false }\n'

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('formats-')

  dirs.push(root)
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function kay(args: string[], cwd = process.cwd()) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

// Stdout is one JSON document on one line, whatever the command or the app printed meanwhile.
function document<T = unknown>(stdout: string): T {
  expect(stdout.endsWith('\n')).toBe(true)
  expect(stdout.trimEnd().split('\n')).toHaveLength(1)

  return JSON.parse(stdout) as T
}

describe('--format', () => {
  it('is refused with the formats a command takes, before it does anything', async () => {
    const built = await kay(['build', '.', '--format', 'yaml'])
    const listed = await kay(['routes', '--format', 'github'])

    expect([built.code, built.stdout]).toEqual([1, ''])
    expect(built.stderr).toBe('kay build: --format takes `text`, `github`, `json`, not `yaml`\n')
    expect([listed.code, listed.stdout]).toEqual([1, ''])
    expect(listed.stderr).toBe('kay routes: --format takes `text`, `json`, not `github`\n')
  })

  it('answers a directory that is none with one error document', async () => {
    for (const command of ['build', 'routes']) {
      const { stdout, stderr, code } = await kay([command, 'no-such-dir', '--format', 'json'])

      expect(code).toBe(1)
      expect(stderr).toBe(`kay ${command}: no-such-dir is not a directory\n`)
      expect(document<unknown>(stdout)).toEqual({ errors: 1, warnings: 0, problems: [{ severity: 'error', code: 'command-usage', message: 'no-such-dir is not a directory' }] })
    }
  })
})

describe('kay build --format json', () => {
  it('gives what it built and each island\'s size, the app\'s own stdout sent to stderr', async () => {
    const root = await project({
      'kay.config.ts': noisyConfig,
      'src/counter.kay': counter,
      'src/routes/index.kay': '--- server\nimport Counter from \'../counter.kay\'\n\nexport const page = { prerender: true }\n---\nCounter\n',
    })
    const { stdout, stderr, code } = await kay(['build', root, '--no-check', '--format', 'json'])
    const built = document<{ errors: number, problems: unknown[], built: { islands: number, prerendered: number, ms: number, sizes: { entry: { size: { gzip: number } }, islands: { file: string, size: { raw: number, gzip: number } }[] } } }>(stdout)

    expect(code, stderr).toBe(0)
    expect(stderr).toContain('loading the config\n')
    expect(stderr).toContain('written\n')
    expect([built.errors, built.problems]).toEqual([0, []])
    expect([built.built.islands, built.built.prerendered]).toEqual([1, 1])
    expect(built.built.ms).toBeGreaterThan(0)
    expect(built.built.sizes.entry.size.gzip).toBeGreaterThan(0)
    expect(built.built.sizes.islands.map(island => island.file)).toEqual(['src/counter.kay'])
    expect(Object.keys(built)).not.toContain('failed')
  }, 30_000)

  it('gives the pages a static export wrote and where', async () => {
    const root = await project({
      'kay.config.ts': 'export default { favicon: false }\n',
      'src/routes/index.kay': '--- server\nexport const page = { prerender: true }\n---\np Home\n',
      'src/routes/about.kay': '--- server\nexport const page = { prerender: true }\n---\np About\n',
    })
    const { stdout, stderr, code } = await kay(['build', root, '--no-check', '--static', '--format', 'json'])
    const built = document<{ built: { islands: number, sizes: { islands: unknown[] } }, exported: { pages: number, dir: string, ms: number } }>(stdout)

    expect(code, stderr).toBe(0)
    expect(built.built.sizes.islands).toEqual([])
    expect(built.exported.pages).toBe(2)
    expect(built.exported.dir).toBe(relative(process.cwd(), join(root, 'dist')))
  }, 30_000)

  it('gives the executable it compiled', async () => {
    const root = await project({
      'kay.config.ts': 'export default { favicon: false }\n',
      'src/routes/index.kay': 'p Home\n',
      'src/server.ts': 'import { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nnew Elysia().use(await pages()).listen(3000)\n',
    })
    const { stdout, stderr, code } = await kay(['build', root, '--no-check', '--compile', join(root, 'server'), '--format', 'json'])
    const built = document<{ compiled: { executable: string, ms: number } }>(stdout)

    expect(code, stderr).toBe(0)
    expect(built.compiled.executable).toBe(relative(process.cwd(), join(root, 'server')))
    expect(built.compiled.ms).toBeGreaterThan(0)
  }, 60_000)

  it('starts the executable it compiled under --verify, and fails the build with the server\'s own error when it cannot start', async () => {
    const serving = 'import { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nnew Elysia().use(await pages()).listen(Number(process.env.PORT))\n'
    const files = { 'kay.config.ts': 'export default { favicon: false }\n', 'src/routes/index.kay': 'p Home\n' }
    const working = await project({ ...files, 'src/server.ts': serving })
    const verified = await kay(['build', working, '--no-check', '--compile', join(working, 'server'), '--verify', '--format', 'json'])

    expect(verified.code, verified.stderr).toBe(0)
    expect(document<{ compiled: { verifiedMs: number } }>(verified.stdout).compiled.verifiedMs).toBeGreaterThan(0)

    const broken = await project({ ...files, 'src/server.ts': `${serving}\nthrow new Error('boom at startup')\n` })
    const failed = await kay(['build', broken, '--no-check', '--compile', join(broken, 'server'), '--verify'])

    expect(failed.code).toBe(1)
    expect(failed.stderr).toContain('the executable exited with code')
    expect(failed.stderr).toContain('boom at startup')
    expect(await Bun.file(join(outputDir(broken), 'executable')).exists()).toBe(false)
    expect(await Bun.file(join(outputDir(working), 'executable')).exists()).toBe(true)

    const alone = await kay(['build', working, '--no-check', '--verify'])

    expect(alone.code).toBe(1)
    expect(alone.stderr).toContain('--verify starts the executable --compile writes')
  }, 120_000)

  describe('verifying an executable', () => {
    // A script run as the executable would be.
    async function executable(script: string): Promise<{ file: string, root: string }> {
      const root = await project({})
      const file = join(root, 'server')

      await Bun.write(file, script)
      await Bun.spawn(['chmod', '755', file]).exited

      return { file, root }
    }

    const serving = (status: number) => `#!/usr/bin/env bun\nBun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT), fetch: () => new Response('', { status: ${status} }) })\nif (process.argv[2] === '--health') process.exit(0)\n`

    it('takes any answer when the health route is off, and fails on a refusal when it is not', async () => {
      const refusing = await executable(serving(404))

      expect(await verifyExecutable(refusing.file, refusing.root, false)).toBeGreaterThan(0)
      await expect(verifyExecutable(refusing.file, refusing.root, undefined, 1500)).rejects.toThrow('did not answer within 1.5 s')
    }, 30_000)

    it('fails when the executable never answers within the time it has', async () => {
      const silent = await executable('#!/bin/sh\necho starting\nexec sleep 30\n')

      await expect(verifyExecutable(silent.file, silent.root, undefined, 600)).rejects.toThrow(/did not answer within 0.6 s\nstarting/)
    }, 30_000)

    it('reports a startup failure though a grandchild still holds its output open', async () => {
      const leaving = await executable('#!/bin/sh\nsleep 5 &\necho "boom at startup" >&2\nexit 1\n')
      const started = performance.now()

      await expect(verifyExecutable(leaving.file, leaving.root, undefined)).rejects.toThrow(/exited with code 1[\s\S]*boom at startup/)
      expect(performance.now() - started).toBeLessThan(4000)
    }, 30_000)

    it('fails when another process answers on the port and the executable exits', async () => {
      const taken = await executable(`#!/bin/sh\n[ "$1" = "--health" ] && exit 0\nbun -e 'Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("other") }); setTimeout(() => process.exit(0), 3000)' >/dev/null 2>&1 &\nsleep 0.1\necho "address in use" >&2\nexit 1\n`)

      await expect(verifyExecutable(taken.file, taken.root, undefined)).rejects.toThrow(/exited with code 1[\s\S]*address in use/)
    }, 30_000)
  })

  it('gives a template that does not compile as a problem at its place, and the stage it stopped', async () => {
    const root = await project({
      'kay.config.ts': 'export default { favicon: false }\n',
      'src/routes/index.kay': 'p Home\neach x in y\n  p {x}\n',
    })
    const { stdout, code } = await kay(['build', root, '--no-check', '--format', 'json'])
    const built = document<{ errors: number, failed: { stage: string }, problems: { file: string, line: number, column: number, code: string | null, message: string }[], built?: unknown }>(stdout)

    expect(code).toBe(1)
    expect(built.failed).toEqual({ stage: 'bundle' })
    expect(built.errors).toBe(1)
    expect(built.built).toBeUndefined()
    expect(built.problems.map(({ file, line, column, code, message }) => ({ file, line, column, code, message }))).toEqual([{ file: relative(process.cwd(), join(root, 'src/routes/index.kay')), line: 2, column: 1, code: 'template-syntax', message: '`each` is pug syntax kay does not have' }])
  }, 30_000)

  it('gives a config that does not load as one error, and nothing built', async () => {
    const root = await project({
      'kay.config.ts': 'throw new Error(\'no settings\')\n',
      'src/routes/index.kay': 'p Home\n',
    })
    const { stdout, code } = await kay(['build', root, '--no-check', '--format', 'json'])
    const built = document<{ errors: number, problems: { message: string, code: string | null }[] }>(stdout)

    expect(code).toBe(1)
    expect(built.errors).toBe(1)
    expect(built.problems[0]!.message).toContain('no settings')
  }, 30_000)

  it('gives an error kay raised its code, whether it stops the build before it starts or while it exports', async () => {
    const config = await project({ 'kay.config.ts': 'export const config = {}\n', 'src/routes/index.kay': 'p Home\n' })
    const guarded = await project({
      'kay.config.ts': 'export default { favicon: false }\n',
      'src/routes/index.kay': 'p Home\n',
      'src/routes/team/[id].kay': '--- server\nexport const page = { prerender: false }\n---\np Team\n',
    })
    const unloaded = await kay(['build', config, '--no-check', '--format', 'json'])
    const exported = await kay(['build', guarded, '--no-check', '--static', '--format', 'json'])

    const globbed = await project({ 'kay.config.ts': 'export default { favicon: false }\n', 'src/routes/index.kay': '---\nimport { signal } from \'kay\'\n\nconst pattern = \'./*.ts\'\nconst files = import.meta.glob(pattern)\nconst n = signal(Object.keys(files).length)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {n()}\n' })
    const bundled = await kay(['build', globbed, '--no-check', '--format', 'json'])

    expect(document<{ problems: { code: string }[] }>(bundled.stdout).problems.map(problem => problem.code)).toEqual(['glob-import'])
    expect(document<{ problems: { code: string }[] }>(unloaded.stdout).problems.map(problem => problem.code)).toEqual(['config-default-export'])
    expect(document<{ problems: { code: string }[] }>(exported.stdout).problems.map(problem => problem.code)).toEqual(['export-needs-params'])
  }, 60_000)
})

describe('kay routes --format json', () => {
  it('gives each route with its kind, file, layouts and guards, every locale\'s copy included, what the app prints sent to stderr', async () => {
    const root = await project({
      'kay.config.ts': noisyConfig.replace('export default { favicon: false }', 'export default { favicon: false, i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\' } }'),
      'src/routes/_layout.kay': 'main\n  slot\n',
      'src/routes/index.kay': 'p Home\n',
      'src/routes/admin/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(() => {})\n',
      'src/routes/admin/report.kay': '--- server\nimport { action } from \'kay/server\'\n\nexport const save = action(() => {})\n---\np Report\n',
      'src/api/items.ts': 'import process from \'node:process\'\nimport { Elysia } from \'elysia\'\n\nconsole.log(\'connecting\')\nprocess.stdout.write(\'items written\\n\')\n\nexport default new Elysia().get(\'/\', () => [])\n',
      'src/api/exits.ts': 'import process from \'node:process\'\n\nprocess.exit(7)\n',
    })
    const { stdout, stderr, code } = await kay(['routes', '--format', 'json'], root)
    const listed = document<{ routes: { methods: string, path: string, kind: string, by: string, file?: string, notes?: string[], layouts?: string[], guards?: string[] }[], unlisted: string[] }>(stdout)
    const own = listed.routes.filter(route => route.kind !== 'kay')

    expect(code, stderr).toBe(0)
    expect(stderr).toBe('loading the config\nwritten\nconnecting\nitems written\n')
    expect(own.map(({ methods, path, kind, file, layouts, guards }) => ({ methods, path, kind, file, layouts, guards }))).toEqual([
      { methods: 'GET', path: '/admin/report', kind: 'page', file: 'src/routes/admin/report.kay', layouts: ['src/routes/_layout.kay'], guards: ['src/routes/admin/_guard.ts'] },
      { methods: 'GET', path: '/fr/admin/report', kind: 'page', file: 'src/routes/admin/report.kay', layouts: ['src/routes/_layout.kay'], guards: ['src/routes/admin/_guard.ts'] },
      { methods: 'POST', path: '/_kay/action/src/routes/admin/report.kay/save', kind: 'action', file: 'src/routes/admin/report.kay', layouts: undefined, guards: undefined },
      { methods: 'GET', path: '/', kind: 'page', file: 'src/routes/index.kay', layouts: ['src/routes/_layout.kay'], guards: [] },
      { methods: 'GET', path: '/fr', kind: 'page', file: 'src/routes/index.kay', layouts: ['src/routes/_layout.kay'], guards: [] },
      { methods: '?', path: '/api/exits/*', kind: 'api', file: 'src/api/exits.ts', layouts: undefined, guards: [] },
      { methods: 'GET', path: '/api/items', kind: 'api', file: 'src/api/items.ts', layouts: undefined, guards: [] },
    ])
    expect(own.find(route => route.file === 'src/api/exits.ts')!.notes![0]).toBe('not loaded: it calls process.exit(7)')
    expect(own.some(route => 'copy' in route)).toBe(false)
    expect(listed.routes.some(route => route.kind === 'kay' && route.path === '/_kay/*')).toBe(true)
    expect(listed.unlisted).toEqual([])
  })
})

describe('kay explain --format json', () => {
  it('lists the lints, or a group\'s, with their summaries whole', async () => {
    const all = document<{ groups: Record<string, string>, lints: { name: string, group: string, level: string, summary: string }[] }>((await kay(['explain', '--format', 'json'])).stdout)
    const islands = document<{ groups: Record<string, string>, lints: { name: string }[] }>((await kay(['explain', 'islands', '--format', 'json'])).stdout)

    expect(all.groups).toEqual(LINT_GROUPS)
    expect(all.lints.map(lint => lint.name)).toEqual(Object.keys(LINTS))
    expect(all.lints[0]).toEqual({ name: 'unread-name', group: 'code', level: 'deny', summary: LINTS['unread-name'].summary })
    expect(islands.groups).toEqual({ islands: LINT_GROUPS.islands })
    expect(islands.lints.map(lint => lint.name)).toEqual(['positional-key', 'identity-key', 'uncalled-signal', 'constant-signal'])
  })

  it('explains one lint with its examples, and answers a name that is none with an error document', async () => {
    const one = await kay(['explain', 'constant-signal', '--format', 'json'])
    const none = await kay(['explain', 'nope', '--format', 'json'])

    expect(document<unknown>(one.stdout)).toEqual({ name: 'constant-signal', ...LINTS['constant-signal'] })
    expect(none.code).toBe(1)
    expect(document<unknown>(none.stdout)).toEqual({ errors: 1, warnings: 0, problems: [{ severity: 'error', code: 'command-usage', message: '`nope` is no lint, error or group; `kay explain` lists them' }] })
  })
})

describe('kay fmt --format json', () => {
  it('gives the files it formatted, or with --check would, and what does not parse as problems', async () => {
    const root = await project({
      'src/a.kay': '---  client\nconst a = 1\n---\np {a}\n',
      'src/b.kay': 'p Fine\n',
      'src/c.kay': 'p Bad\neach x in y\n',
    })
    const checked = await kay(['fmt', 'src', '--check', '--format', 'json'], root)
    const report = document<{ errors: number, warnings: number, written: boolean, changed: string[], problems: { file: string, line: number, message: string }[] }>(checked.stdout)

    expect(checked.code).toBe(1)
    expect(report.written).toBe(false)
    expect(report.changed).toEqual(['src/a.kay'])
    expect([report.errors, report.warnings]).toEqual([1, 0])
    expect(report.problems.map(({ file, line }) => ({ file, line }))).toEqual([{ file: 'src/c.kay', line: 2 }])
    expect(await Bun.file(join(root, 'src/a.kay')).text()).toBe('---  client\nconst a = 1\n---\np {a}\n')

    await rm(join(root, 'src/c.kay'))

    const written = await kay(['fmt', 'src', '--format', 'json'], root)

    expect(written.code).toBe(0)
    expect(document<unknown>(written.stdout)).toEqual({ errors: 0, warnings: 0, problems: [], written: true, changed: ['src/a.kay'] })
    expect(await Bun.file(join(root, 'src/a.kay')).text()).toBe('--- client\nconst a = 1\n---\np {a}\n')
  })

  it('answers a path that is none with an error document', async () => {
    const { stdout, stderr, code } = await kay(['fmt', 'nowhere', '--format', 'json'])

    expect(code).toBe(1)
    expect(stderr).toBe('kay fmt: nowhere does not exist\n')
    expect(document<unknown>(stdout)).toEqual({ errors: 1, warnings: 0, problems: [{ severity: 'error', code: 'command-usage', message: 'nowhere does not exist' }] })
  })
})

describe('kay migrate --format json', () => {
  it('gives the files written and kept and what is left to do by hand', async () => {
    const root = await project({
      'package.json': '{ "dependencies": { "astro": "^5.0.0" } }',
      'src/pages/index.astro': '<h1>Home</h1>\n',
      'src/pages/api/ping.ts': 'export const GET = () => new Response(\'pong\')\n',
      'src/components/kept.kay': 'p Mine\n',
      'src/components/Kept.astro': '<p>Theirs</p>\n',
    })

    await mkdir(join(root, 'public'), { recursive: true })

    const { stdout, stderr, code } = await kay(['migrate', 'astro', '.', '--format', 'json'], root)
    const report = document<{ written: string[], kept: string[], copied: number, notes: { file: string, line: number, message: string }[] }>(stdout)

    expect(code, stderr).toBe(0)
    expect(report.written).toEqual(['src/routes/index.kay'])
    expect(report.kept).toEqual(['src/components/kept.kay'])
    expect(report.notes.map(note => note.file)).toEqual(['package.json', 'src/pages/api/ping.ts'])
  })

  it('answers what it does not migrate from with an error document', async () => {
    const { stdout, code } = await kay(['migrate', 'gatsby', '--format', 'json'])

    expect(code).toBe(1)
    expect(document<unknown>(stdout)).toEqual({ errors: 1, warnings: 0, problems: [{ severity: 'error', code: 'command-usage', message: 'gatsby is not something kay migrates from, as in `kay migrate astro`' }] })
  })
})
