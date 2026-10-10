import type { Subprocess } from 'bun'
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { parse, stringify } from 'devalue'
import { buildClient } from '../src/build/client'
import { check, configCheckOptions } from '../src/check'
import { loadConfig } from '../src/config'
import { formatFiles } from '../src/format'
import { createProject, FEATURE_NAMES, PRESETS, toggle } from '../src/new'
import { limiter } from '../src/server/limit'

const repo = join(import.meta.dir, '..')
const LISTENING = /localhost:(\d+)/
// Top-level imports of the Node modules a compiled server loads only once a feature needs them.
const EAGER_BUILTINS = [...['zlib', 'crypto', 'http'].flatMap(name => [`from "${name}"`, `from "node:${name}"`]), 'from "bun:sqlite"']
// A Postgres whose user may create databases, for the scaffolded app's tests: CI sets it, as pg-orm's own tests have one.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const ACCENT_TEST = `import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { expect, it } from 'bun:test'
import { mount, settle, testSite } from 'kay/test'
import { encodeValue } from __WIRE__

const site = await testSite()
const accentStyle = async (value: string) => (await site.visit('/', { headers: { cookie: \`accent=\${encodeURIComponent(encodeValue(value))}\` } })).html

it('renders the kept accent from the first paint, a known one only', async () => {
  expect(await accentStyle('mauve')).toContain('<style>:root { --accent: var(--accent-mauve); }</style>')
  expect(await accentStyle('x); } body { display: none')).toContain('<style>:root { --accent: var(--accent-peach); }</style>')
})

it('changes the accent on a click', async () => {
  // A page of a site, whose cookies the document keeps.
  GlobalRegistrator.register({ url: 'http://localhost/' })

  try {
    const { root, unmount } = await mount('src/components/accent-picker.kay')

    root.querySelector<HTMLButtonElement>('[aria-label="mauve"]')!.click()
    await settle()

    expect(root.querySelector('style')!.textContent).toBe(':root { --accent: var(--accent-mauve); }')
    expect(root.querySelector('[aria-label="mauve"]')!.getAttribute('aria-checked')).toBe('true')
    expect(document.cookie).toContain('accent=')
    unmount()
  }
  finally {
    await GlobalRegistrator.unregister()
  }
})
`

// What `kay check` reports of the project, kay.config.ts read as it reads it: a warning fails the `check` script a scaffold writes.
async function checked(dir: string) {
  return check(dir, configCheckOptions(await loadConfig(dir)))
}

// Stands in for `bun install` of a packed kay: its source and what `prepack` emits, the declarations and the ESLint processor, beside this checkout's dependencies.
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

  const processor = await Bun.build({ entrypoints: [join(repo, 'src/eslint/index.ts')], target: 'node', packages: 'external', outdir: join(kay, 'dist'), naming: 'eslint.js' })

  expect(processor.success).toBe(true)
}

// The scaffolds the concurrent tests below run at once: each runs tsgo, ESLint and its own tests, and all twenty at once ran a machine out of memory.
const scaffold = limiter(4)

// Lints as `bun run lint` does, through keslint and the eslint it runs under Node, as JSON.
async function lint(dir: string, path: string): Promise<{ filePath: string, messages: { ruleId: string | null, line: number }[] }[]> {
  const child = Bun.spawn([join(dir, 'node_modules/.bin/keslint'), '--format', 'json', path], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  expect(stderr).toBe('')

  return JSON.parse(stdout) as { filePath: string, messages: { ruleId: string | null, line: number }[] }[]
}

async function kay(args: string[], cwd?: string): Promise<{ stdout: string, stderr: string, code: number }> {
  const child = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), ...args], { cwd: cwd ?? process.cwd(), stdout: 'pipe', stderr: 'pipe' })
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
      const { stdout, code } = await kay(['new', 'my app {x}', '--kay', '^1.0.0'], dir)
      const manifest = await Bun.file(join(dir, 'my app {x}/package.json')).json() as { name: string }

      expect(code).toBe(0)
      expect(manifest.name).toBe('my-app-x')
      expect(await Bun.file(join(dir, 'my app {x}/src/components/header.kay')).text()).toContain('(href="/") my-app-x\n')
      expect(await Bun.file(join(dir, 'my app {x}/kay.config.ts')).text()).toContain('seo: { name: \'my-app-x\', titleTemplate: \'%s | my-app-x\'')
      expect(stdout).toContain('cd \'my app {x}\' && bun install')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('scaffolds a preset as --with and --without change it, refusing a feature it does not know or one without what it needs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))

    try {
      expect((await kay(['new', 'styled', '--kay', '^1.0.0', '--template', 'blank', '--with', 'tailwind, tests'], dir)).code).toBe(0)
      expect((await readdir(join(dir, 'styled'), { recursive: true })).sort()).toEqual(['.gitignore', '.npmrc', 'AGENTS.md', 'bunfig.toml', 'kay.config.ts', 'package.json', 'src', 'src/app.css', 'src/routes', 'src/routes/_layout.kay', 'src/routes/index.kay', 'tests', 'tests/home.test.ts', 'tsconfig.json'])
      expect((await kay(['new', 'lean', '--kay', '^1.0.0', '--without', 'docker,ci'], dir)).code).toBe(0)
      expect(await readdir(join(dir, 'lean'))).not.toEqual(expect.arrayContaining(['Dockerfile']))
      expect(await Bun.file(join(dir, 'lean/src/server.ts')).exists()).toBe(true)
      expect(await kay(['new', 'unknown', '--with', 'bogus'], dir)).toEqual({ stdout: '', stderr: 'kay new: bogus is none of the features server, starter, tailwind, accents, eslint, tests, ci, docker, auth, ws\n', code: 1 })
      expect(await kay(['new', 'both', '--with', 'docker', '--without', 'ci,docker'], dir)).toEqual({ stdout: '', stderr: 'kay new: docker is in both --with and --without\n', code: 1 })
      expect(await kay(['new', 'static', '--kay', '^1.0.0', '--template', 'site', '--with', 'auth'], dir)).toEqual({ stdout: '', stderr: 'kay: auth needs server: add --with server, or drop it with --without auth\n', code: 1 })
      expect(await kay(['new', 'unstyled', '--kay', '^1.0.0', '--without', 'tailwind'], dir)).toEqual({ stdout: '', stderr: 'kay: accents needs tailwind: add --with tailwind, or drop it with --without accents\n', code: 1 })
      expect((await readdir(dir)).sort()).toEqual(['lean', 'styled'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('asks in a terminal for a preset, then for its features one by one, and scaffolds what was checked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))
    let screen = ''
    const terminal = new Bun.Terminal({ cols: 120, data: (_terminal, data) => void (screen += new TextDecoder().decode(data)) })

    try {
      const child = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'new', 'picked', '--kay', '^1.0.0'], { cwd: dir, terminal })

      await shown(() => screen, 'Start from')
      // From the server preset up to blank, then server checked, and the accent picker with the starter pages and Tailwind it needs.
      terminal.write('\x1B[A\r')
      await shown(() => screen, 'Features')
      // Home and Ctrl+Down, which the picker does not read, leave it open.
      terminal.write('\x1B[H\x1B[1;5B \x1B[B\x1B[B\x1B[B \r')

      expect(await child.exited).toBe(0)
      expect(screen).toContain('Start from \x1B[36mblank')
      expect(screen).toContain('Features \x1B[36mserver, starter, tailwind, accents\x1B')

      const files = await readdir(join(dir, 'picked'), { recursive: true })

      expect(files).toEqual(expect.arrayContaining(['src/server.ts', 'src/app.css', 'src/components/accent-picker.kay', 'src/components/header.kay']))
      expect(files).not.toEqual(expect.arrayContaining(['eslint.config.ts']))
      expect(files).not.toEqual(expect.arrayContaining(['bunfig.toml']))
    }
    finally {
      terminal.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('writes nothing once the terminal prompt is cancelled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-cli-'))
    let screen = ''
    const terminal = new Bun.Terminal({ data: (_terminal, data) => void (screen += new TextDecoder().decode(data)) })

    try {
      const child = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'new', 'dropped', '--kay', '^1.0.0'], { cwd: dir, terminal })

      await shown(() => screen, 'Start from')
      terminal.write('\x03')

      expect(await child.exited).toBe(1)
      await shown(() => screen, 'kay new: cancelled, nothing written')
      expect(await readdir(dir)).toEqual([])
    }
    finally {
      terminal.close()
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)

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
      const manifest = await Bun.file(join(dir, 'package.json')).json() as { dependencies: Record<string, string>, devDependencies: Record<string, string>, scripts: Record<string, string> }

      expect(files).toContain('src/routes/index.kay')
      // The container runs the one executable `kay build --compile` makes.
      expect(files).toEqual(expect.arrayContaining(['Dockerfile', 'compose.prod.yaml', 'src/components/accent-picker.kay']))
      expect(manifest.scripts.compile).toBe('kay build --compile server')
      // A warning fails CI as an error does, so none piles up unread.
      expect(manifest.scripts.check).toBe('kay check --deny-warnings')
      expect(await Bun.file(join(dir, 'AGENTS.md')).text()).toContain('run `bun run check`, `bun run fmt`, `bun run lint`, and `bun run test`.')
      expect(await Bun.file(join(dir, 'Dockerfile')).text()).toContain('RUN bun run compile')
      expect(await Bun.file(join(dir, 'Dockerfile')).text()).toContain('HEALTHCHECK --interval=30s --timeout=6s CMD ["./server", "--health"]')
      expect(Object.keys(manifest.devDependencies)).toEqual(['@iconify-json/tabler', '@kaynooo/eslint', '@types/bun', 'bun-plugin-tailwind', 'tailwindcss'])
      expect(await Bun.file(join(dir, '.npmrc')).text()).toBe('@kaynooo:registry=https://git.kaynooo.fr/api/packages/kaynooo/npm/\n')
      expect(manifest.dependencies.kay).toBe('^1.0.0')
      expect(await Bun.file(join(dir, 'src/components/header.kay')).text()).toContain('(href="/") my-app\n')
      // As strict as kay itself, and checked, linted and tested on every push.
      expect(await Bun.file(join(dir, 'tsconfig.json')).json()).toEqual({ extends: 'kay/tsconfig.json' })
      expect(((await Bun.file(join(repo, 'src/tsconfig.app.json')).json()) as { compilerOptions: Record<string, unknown> }).compilerOptions).toMatchObject({ strict: true, exactOptionalPropertyTypes: true, noFallthroughCasesInSwitch: true, noImplicitOverride: true, noUncheckedIndexedAccess: true })
      expect(await Bun.file(join(dir, '.forgejo/workflows/test.yml')).text()).toContain('run: bun run check\n\n      # After the check, which writes the types the lint of .kay files reads.\n      - name: Lint\n        run: bun run lint\n\n      - name: Test\n        run: bun run test\n')

      await installKay(dir)

      // Stricter than kay itself: its source fails this flag, its declarations must not.
      const scaffolded = await Bun.file(join(dir, 'tsconfig.json')).text()
      const tsconfig = JSON.parse(scaffolded) as { compilerOptions: Record<string, unknown> }

      await Bun.write(join(dir, 'tsconfig.json'), JSON.stringify({ ...tsconfig, compilerOptions: { ...tsconfig.compilerOptions, exactOptionalPropertyTypes: true } }))
      expect(await checked(dir)).toEqual([])
      expect((await formatFiles([join(dir, 'src')], { write: false })).changed).toEqual([])
      // The scaffolded tsconfig, as lint reads every file of the project.
      await Bun.write(join(dir, 'tsconfig.json'), scaffolded)
      expect((await lint(dir, '.')).flatMap(result => result.messages)).toEqual([])

      // A page's server fence is linted with the project's types, at its .kay line.
      await Bun.write(join(dir, 'src/routes/later.kay'), '--- server\nBun.write(\'later.txt\', \'later\')\n---\np Later\n')
      expect(await checked(dir)).toEqual([])
      expect((await lint(dir, 'src/routes/later.kay'))[0]!.messages).toEqual([expect.objectContaining({ ruleId: 'ts/no-floating-promises', line: 2 })])
      await rm(join(dir, 'src/routes/later.kay'))

      // The accent picker as a visitor meets it: rendered from the cookie, a value it does not know read as the default, and changed by a click.
      await Bun.write(join(dir, 'tests/accent.test.ts'), ACCENT_TEST.replace('__WIRE__', JSON.stringify(join(repo, 'src/runtime/wire'))))

      const tests = Bun.spawn([process.execPath, 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
      const [report, code] = await Promise.all([new Response(tests.stderr).text(), tests.exited])

      expect(report).toContain('3 pass')
      expect(code).toBe(0)

      const client = await buildClient(dir)

      expect(Object.keys(client.islands)).toEqual(['src/components/accent-picker.kay', 'src/components/counter.kay'])
      const stylesheet = client.styles.get(join(dir, 'src/routes/_layout.kay'))!

      expect(await Bun.file(join(client.dir, stylesheet.slice('/_kay/'.length))).text()).toMatch(/@media \(prefers-reduced-motion: ?no-preference\) ?\{\s*@view-transition/)
    }
    finally {
      await rm(join(dir, '..'), { recursive: true, force: true })
    }
  }, 30_000)

  it('scaffolds a static site that type-checks and exports to dist, with a Pages workflow and a container beside it', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-site')

    try {
      const files = await createProject(dir, { kay: '^1.0.0', features: PRESETS.site.features })
      const manifest = await Bun.file(join(dir, 'package.json')).json() as { scripts: Record<string, string> }

      expect(files).toContain('.forgejo/workflows/pages.yml')
      expect(files).toContain('Dockerfile')
      expect(files).not.toContain('src/server.ts')
      expect(manifest.scripts.build).toBe('kay build --static')
      expect(await Bun.file(join(dir, '.forgejo/workflows/pages.yml')).text()).toContain('SITE_BASE: /${{ github.repository }}')
      // Tested before it builds, which checks it, and linted once the check has written the types it reads.
      expect(await Bun.file(join(dir, '.forgejo/workflows/pages.yml')).text()).toMatch(/run: bun run test\n\n {6}- name: Build the site\n/)
      expect(await Bun.file(join(dir, '.forgejo/workflows/pages.yml')).text()).toMatch(/run: bun run build\n\n.*\n {6}- name: Lint\n {8}run: bun run lint\n/)

      await installKay(dir)
      expect(await checked(dir)).toEqual([])
      expect((await lint(dir, '.')).flatMap(result => result.messages)).toEqual([])

      // With no server entry, `kay dev` serves the pages with kay's own, live reload included.
      const server = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'dev'], { cwd: dir, env: { ...process.env, PORT: '0' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

      try {
        const home = await (await fetch(`http://localhost:${await listeningPort(server)}/`)).text()

        expect(home).toContain('<title>Home | my-site</title>')
        expect(home).toContain('new EventSource("/_kay/dev/events")')
      }
      finally {
        server.kill()
        await server.exited
      }

      const build = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', '--static'], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, SITE_URL: 'https://pages.example', SITE_BASE: '/me/my-site' } })
      const [report, code] = await Promise.all([new Response(build.stdout).text(), build.exited])

      expect(report).toContain('exported 1 page')
      expect(code).toBe(0)
      const html = await Bun.file(join(dir, 'dist/index.html')).text()
      const stylesheet = await Bun.file(join(dir, 'dist', (/href="\/me\/my-site\/(_kay\/[^"]+\.css)"/).exec(html)![1]!)).text()

      expect(html).toContain('<link rel="canonical" href="https://pages.example/me/my-site/">')
      expect(html).toContain('<title>Home | my-site</title>')
      expect(html).toContain('<a class="skip-link" href="#main-content">')
      expect(html).toContain('<style>:root { --accent: var(--accent-peach); }</style>')
      // Every accent the picker offers, though only the picker reads them.
      expect(stylesheet.match(/--accent-[a-z]+:#/g)).toHaveLength(14)
      expect(stylesheet).toContain('.text-accent')
      expect(await Bun.file(join(dir, 'dist/404.html')).exists()).toBe(true)
    }
    finally {
      await rm(join(dir, '..'), { recursive: true, force: true })
    }
  }, 30_000)

  it('scaffolds an app with sessions, members in Postgres, a guarded section and a websocket island, which checks, tests and builds as it is', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')

    try {
      const files = await createProject(dir, { kay: '^1.0.0', features: PRESETS.app.features })

      expect(files).toEqual(expect.arrayContaining(['.env', '.env.example', '.env.test', 'compose.dev.yaml', 'migrations/0001_member.sql', 'pg-orm.config.ts', 'src/db/index.ts', 'src/routes/account/_guard.ts', 'src/api/online.ts', 'tests/account.test.ts', 'tests/database.ts', 'tests/members.test.ts', 'tests/online.test.ts']))
      expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600)
      expect(await Bun.file(join(dir, '.env')).text()).toMatch(/^SESSION_SECRET=[0-9a-f]{64}\nDATABASE_URL=postgres:\/\/app:app@127\.0\.0\.1:5433\/app\nCOMPOSE_FILE=compose\.dev\.yaml\n$/)
      expect(await Bun.file(join(dir, '.gitignore')).text()).toContain('.env')
      expect(await Bun.file(join(dir, 'compose.prod.yaml')).text()).toContain('SESSION_SECRET: ${SESSION_SECRET:?set SESSION_SECRET}')

      await installKay(dir)
      expect(await checked(dir)).toEqual([])
      expect((await formatFiles([join(dir, 'src')], { write: false })).changed).toEqual([])
      expect((await lint(dir, '.')).flatMap(result => result.messages)).toEqual([])

      // Signs in through the action and lands in the guarded section, reads a seeded member, and counts the visitors online over the websocket, each test file on a database of its own.
      // They need a Postgres the test user may create databases on, which CI always has.
      if ((TEST_DATABASE_URL ?? '') !== '' || (process.env.CI ?? '') !== '') {
        const tests = Bun.spawn([process.execPath, 'run', 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...TEST_DATABASE_URL !== undefined && TEST_DATABASE_URL !== '' && { DATABASE_URL: TEST_DATABASE_URL } } })
        const [report, code] = await Promise.all([new Response(tests.stderr).text(), tests.exited])

        expect(report).toContain('5 pass')
        expect(code).toBe(0)
      }

      expect(Object.keys((await buildClient(dir)).islands).toSorted()).toEqual(['src/components/accent-picker.kay', 'src/components/counter.kay', 'src/components/online.kay'])
    }
    finally {
      await rm(join(dir, '..'), { recursive: true, force: true })
    }
  }, 30_000)

  it('scaffolds a blank project of one bare page, which checks and builds as a static site', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')

    try {
      const files = await createProject(dir, { kay: '^1.0.0', features: PRESETS.blank.features })
      const manifest = await Bun.file(join(dir, 'package.json')).json() as { dependencies: Record<string, string>, devDependencies: Record<string, string>, scripts: Record<string, string> }

      expect(files).toEqual(['.gitignore', '.npmrc', 'AGENTS.md', 'kay.config.ts', 'package.json', 'src/routes/_layout.kay', 'src/routes/index.kay', 'tsconfig.json'])
      // kay itself comes from the registry this names, whatever else is left out.
      expect(await Bun.file(join(dir, '.npmrc')).text()).toBe('@kaynooo:registry=https://git.kaynooo.fr/api/packages/kaynooo/npm/\n')
      expect(manifest.scripts).toEqual({ dev: 'kay dev', build: 'kay build --static', check: 'kay check --deny-warnings', fmt: 'kay fmt' })
      // An agent reads kay's docs as installed, and runs the checks this project's scripts hold.
      expect(await Bun.file(join(dir, 'AGENTS.md')).text()).toBe('# my-app\n\nBuilt with kay, a Bun web framework: a `.kay` file is one component, TypeScript fences then a pug-like template. Read kay\'s docs for the installed version before writing kay code; the topic files they link are in `node_modules/kay/llms/`:\n\n@node_modules/kay/llms.txt\n\nBefore calling a change done, run `bun run check` and `bun run fmt`.\n')
      // Published, so the docs AGENTS.md imports are in node_modules/kay.
      expect(((await Bun.file(join(repo, 'package.json')).json()) as { files: string[] }).files).toEqual(expect.arrayContaining(['llms', 'llms.txt']))
      expect(Object.keys(manifest.devDependencies)).toEqual(['@types/bun'])
      expect(Object.keys(manifest.dependencies)).toEqual(['elysia', 'kay'])

      await installKay(dir)
      expect(await checked(dir)).toEqual([])
      expect((await formatFiles([join(dir, 'src')], { write: false })).changed).toEqual([])

      const build = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'build', '--static'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
      const [report, code] = await Promise.all([new Response(build.stdout).text(), build.exited])

      expect(report).toContain('exported 1 page')
      expect(code).toBe(0)
      expect(await Bun.file(join(dir, 'dist/index.html')).text()).toContain('<main><h1>my-app</h1></main>')
      // With no _404.kay, no 404.html, which the nginx.conf of a site without the starter pages does not name.
      expect(await Bun.file(join(dir, 'dist/404.html')).exists()).toBe(false)
    }
    finally {
      await rm(join(dir, '..'), { recursive: true, force: true })
    }
  }, 30_000)

  // Each feature alone, and the app with each one left out, a few at a time: every project is a directory of its own. A test's timeout counts its wait for a slot, so it holds the whole run of them.
  for (const [label, variant] of FEATURE_NAMES.flatMap(feature => [[`${feature} alone`, toggle(new Set(), feature)], [`the app without ${feature}`, toggle(new Set(PRESETS.app.features), feature)]] as const)) {
    it.concurrent(`scaffolds ${label} as a project that checks, is formatted, lints and passes its tests`, async () => {
      await scaffold(async () => {
        const features = [...variant]
        const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')

        try {
          await createProject(dir, { kay: '^1.0.0', features })
          await installKay(dir)
          expect({ features, problems: await checked(dir) }).toEqual({ features, problems: [] })
          expect({ features, changed: (await formatFiles([join(dir, 'src')], { write: false })).changed }).toEqual({ features, changed: [] })

          if (variant.has('docker') && !variant.has('server'))
            expect({ features, notFound: (await Bun.file(join(dir, 'nginx.conf')).text()).includes('error_page 404 /404.html') }).toEqual({ features, notFound: variant.has('starter') })

          if (variant.has('eslint'))
            expect({ features, messages: (await lint(dir, '.')).flatMap(result => result.messages) }).toEqual({ features, messages: [] })

          // An app's tests need a Postgres, which the app preset's own test runs them on.
          if (variant.has('tests') && !variant.has('auth')) {
            const tests = Bun.spawn([process.execPath, 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
            const [report, code] = await Promise.all([new Response(tests.stderr).text(), tests.exited])

            expect({ features, code, report }).toEqual({ features, code: 0, report: expect.stringContaining(' 0 fail') })
          }
        }
        finally {
          await rm(join(dir, '..'), { recursive: true, force: true })
        }
      })
    }, 240_000)
  }

  it('checks what a feature needs along with it, and unchecks what needs it along with it', () => {
    expect([...toggle(new Set(), 'accents')]).toEqual(['accents', 'starter', 'tailwind'])
    expect([...toggle(new Set(PRESETS.app.features), 'server')]).toEqual([...PRESETS.site.features])
    expect([...toggle(new Set(PRESETS.server.features), 'tailwind')]).toEqual(['server', 'starter', 'eslint', 'tests', 'ci', 'docker'])
  })

  it('refuses a feature without what it needs, before writing anything', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kay-new-')), 'my-app')

    try {
      await expect(createProject(dir, { kay: '^1.0.0', features: ['accents'] })).rejects.toThrow('kay: accents needs starter and tailwind: add --with starter,tailwind, or drop it with --without accents')
      expect(await readdir(join(dir, '..'))).toEqual([])
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

// Waits for a terminal program to print `text`.
async function shown(screen: () => string, text: string): Promise<void> {
  for (let waited = 0; !screen().includes(text); waited += 10) {
    if (waited > 10_000)
      throw new Error(`never shown: ${text}\n${screen()}`)

    await Bun.sleep(10)
  }
}

// The first line a server prints with the port it listens on.
async function listeningPort(child: Subprocess<'ignore', 'pipe', 'pipe'>): Promise<string> {
  const reader = child.stdout.getReader()
  let output = ''

  for (let match = LISTENING.exec(output); !match; match = LISTENING.exec(output)) {
    const { value, done } = await reader.read()

    if (done)
      throw new Error(`the executable exited without listening: ${await new Response(child.stderr).text()}`)

    output += new TextDecoder().decode(value)
  }

  reader.releaseLock()

  return LISTENING.exec(output)![1]!
}

describe('kay build --compile', () => {
  it('refuses --entry without --compile, before building anything', async () => {
    const build = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'build', tmpdir(), '--entry', 'src/server.ts'], { stdout: 'pipe', stderr: 'pipe' })
    const [report, code] = await Promise.all([new Response(build.stderr).text(), build.exited])

    expect(report).toContain('--entry names the server an executable runs, so it goes with --compile')
    expect(code).toBe(1)
  })

  it('bundles the server, its pages and the client build into one executable that serves them from anywhere', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'kay-compile-')), 'my-app')

    try {
      await createProject(dir, { kay: '^1.0.0' })
      await installKay(dir)
      await Promise.all(Object.entries({
        'public/robots.txt': 'User-agent: *\n',
        // A static component with relative imports of its own, so its island twin resolves them too.
        'src/components/shout.ts': 'export const shout = (text: string) => text.toUpperCase()\n',
        'src/components/dot.kay': 'i.dot\n',
        'src/components/badge.kay': '---\nimport Dot from \'./dot.kay\'\nimport { shout } from \'./shout\'\n\nconst { labels } = props<{ labels: string[] }>()\n---\nul.badges\n  for label of labels key={label}\n    li\n      Dot\n      | {shout(label)}\n',
        'src/components/tally.kay': '---\nimport { signal } from \'kay\'\nimport Badge from \'./badge.kay\'\n\nconst n = signal(0)\n---\nBadge(labels={[\'in\']})\nbutton(onClick={() => n.set(c => c + 1)}) {n()}\n',
        'src/routes/badges.kay': '---\nimport Badge from \'../components/badge.kay\'\nimport Tally from \'../components/tally.kay\'\n---\nBadge(labels={[\'out\']})\nTally\n',
        'src/routes/about.kay': '--- server\nexport const page = { prerender: true }\n---\np About\n',
        'src/routes/echo.kay': '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const shout = action(t.Object({ text: t.String({ maxLength: 200 }) }), ({ text }) => text.toUpperCase())\n---\np Echo\n',
        'src/routes/admin/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ deny }) => deny(403, \'Admins only\'))\n',
        'src/routes/admin/index.kay': 'p Secret\n',
        'src/content.config.ts': 'import { t } from \'elysia\'\nimport { collection } from \'kay/content\'\n\nexport const notes = collection(\'content/notes\', {\n  schema: t.Object({ title: t.String(), date: t.Date() }),\n  feed: { path: \'/notes.xml\', title: \'Notes\', item: note => ({ title: note.data.title, path: `/notes/${note.slug}`, date: note.data.date }) },\n})\n',
        'src/content/notes/first.md': '---\ntitle: First note\ndate: 2026-09-01\n---\n\n## Read me\n',
        'src/routes/notes/[slug].kay': '--- server\nimport { notes } from \'../../content.config\'\n\nconst note = await notes.get(ctx.params.slug) ?? ctx.notFound()\nconst { Content } = note\n---\nh1 {note.data.title}\nContent\n',
        'src/routes/photo.kay': '---\nimport { image } from \'kay/image\'\nimport hero from \'../hero.png\'\n---\nimg({...image(hero)} alt="Hero")\n',
        'src/api/ping.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => \'pong\')\n',
        'src/api/members/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ deny }) => deny(403, \'Members only\'))\n',
        'src/api/members/index.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => \'secret\')\n',
        // A kay library whose settings the app replaces, on a page the build prerenders and one the executable renders.
        'node_modules/kay-lib/package.json': JSON.stringify({ name: 'kay-lib', version: '1.0.0', type: 'module', peerDependencies: { kay: '*' }, exports: { './*.kay': './src/*.kay' }, kay: { settings: './src/settings.ts' } }),
        'node_modules/kay-lib/src/settings.ts': 'export default { icon: (name: string) => `default:${name}` }\n',
        'node_modules/kay-lib/src/tag.kay': '---\nimport { signal } from \'kay\'\nimport settings from \'./settings\'\n\nconst { label } = props<{ label: string }>()\nconst open = signal(false)\n---\nbutton.tag(onClick={() => open.set(o => !o)}) {settings.icon(label)}\n',
        'src/ui-settings.ts': 'export default { icon: (name: string) => `app:${name}` }\n',
        'src/routes/tags.kay': '---\nimport Tag from \'kay-lib/tag.kay\'\n---\n--- server\nexport const page = { prerender: true }\n---\nTag(label="kept")\n',
        'src/routes/live-tags.kay': '---\nimport Tag from \'kay-lib/tag.kay\'\n---\nTag(label="live")\n',
        // A build plugin reading a file beside it as it loads, as a native binding does: the executable must not load it.
        'node_modules/build-stamp/package.json': JSON.stringify({ name: 'build-stamp', version: '1.0.0', type: 'module', exports: { types: './index.d.ts', default: './index.js' } }),
        'node_modules/build-stamp/index.d.ts': 'declare const stamp: () => import(\'bun\').BunPlugin\nexport default stamp\n',
        'node_modules/build-stamp/index.js': 'import { readFileSync } from \'node:fs\'\nimport { join } from \'node:path\'\n\nconst binding = readFileSync(join(import.meta.dir, \'binding.txt\'), \'utf8\')\n\nexport default () => ({ name: binding, setup() {} })\n',
        'node_modules/build-stamp/binding.txt': 'stamp',
        'kay.config.ts': 'import stamp from \'build-stamp\'\nimport { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ plugins: [stamp()], lang: \'en\', site: \'https://example.com\', favicon: \'src/favicon.png\', fonts: [{ family: \'Display\', src: \'src/display.woff2\' }], settings: { \'kay-lib\': \'./src/ui-settings.ts\' }, images: { dirs: { \'/uploads/\': \'uploads\' } } })\n',
      }).map(async ([path, content]) => Bun.write(join(dir, path), content)))
      // Images, the favicon and fonts are read from the project at build time only: the executable serves what the build made of them.
      await Promise.all([
        Bun.write(join(dir, 'src/hero.png'), Bun.file(join(repo, 'tests/fixtures/images/src/hero.png'))),
        Bun.write(join(dir, 'src/favicon.png'), Bun.file(join(repo, 'tests/fixtures/seo/src/favicon.png'))),
        Bun.write(join(dir, 'src/display.woff2'), Bun.file(join(repo, 'tests/fixtures/seo/src/fonts/display.woff2'))),
      ])

      const manifest = await Bun.file(join(dir, 'package.json')).json() as { dependencies: Record<string, string> }

      await Bun.write(join(dir, 'package.json'), JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, 'kay-lib': '1.0.0' } }))

      const build = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'build', '--compile', 'server'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
      const [report, code] = await Promise.all([new Response(build.stdout).text(), build.exited])

      expect(report).toContain('compiled server in ')
      expect(code).toBe(0)
      // Serving the build it embeds, it carries neither kay's compiler nor Babel, and loads zlib, crypto, http and SQLite only once a feature needs them.
      const executable = Buffer.from(await Bun.file(join(dir, 'server')).bytes())

      expect(executable.includes('compiler/codegen.ts')).toBe(false)
      expect(EAGER_BUILTINS.filter(statement => executable.includes(statement))).toEqual([])
      await rm(join(dir, 'node_modules/build-stamp'), { recursive: true })

      // Run from elsewhere, with nothing of the project to read but an upload.
      const elsewhere = join(dir, '..', 'elsewhere')

      await Bun.write(join(elsewhere, 'uploads/photo.png'), Bun.file(join(repo, 'tests/fixtures/images/src/hero.png')))

      const server = Bun.spawn([join(dir, 'server')], { cwd: elsewhere, env: { PATH: process.env.PATH, PORT: '0' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

      try {
        const port = await listeningPort(server)
        const origin = `http://localhost:${port}`
        const get = async (path: string) => {
          const response = await fetch(`${origin}${path}`)

          return { status: response.status, text: await response.text() }
        }
        const home = await get('/')
        const entry = (/<script type="module" src="([^"]+)"/).exec(home.text)![1]!
        const badges = await get('/badges')
        const about = await fetch(`${origin}/about`, { headers: { 'accept-encoding': 'br' } })
        const call = await fetch(`${origin}/_kay/action/src/routes/echo.kay/shout`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'origin': origin }, body: stringify({ text: 'hi' }) })

        expect(home.text).toContain('Hello from the server</h1>')
        expect((await get(entry)).status).toBe(200)
        expect(await get('/robots.txt')).toEqual({ status: 200, text: 'User-agent: *\n' })
        // The copy `kay build` prerendered and compressed, not a render.
        expect(about.headers.get('etag')).toEndWith('-br"')
        expect(await about.text()).toContain('<p>About</p>')
        expect(badges.text).toContain('<ul class="badges"><li><i class="dot"></i>OUT</li></ul>')
        expect(badges.text).toContain('<slot data-component="src/components/tally.kay" data-props="[{}]"><!--[--><ul class="badges"><li><!--[--><i class="dot"></i><!--]--><!--[-->IN<!--]--></li></ul><!--]--><button>0</button></slot>')
        expect(parse(await call.text())).toBe('HI')
        expect(await get('/admin')).toEqual({ status: 403, text: 'Admins only' })
        expect(await get('/api/ping')).toEqual({ status: 200, text: 'pong' })
        expect(await get('/api/members')).toEqual({ status: 403, text: 'Members only' })
        expect((await get('/missing')).text).toContain('Nothing here</h1>')

        const photo = await get('/photo')
        const variant = (/srcset="([^ "]+) 320w/).exec(photo.text)![1]!.replaceAll('&amp;', '&')
        const font = (/<style>@font-face\{font-family:"Display";src:url\("([^"]+)"\)/).exec(home.text)![1]!
        const image = await fetch(`${origin}${variant}`)

        expect(image.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
        expect((await new Bun.Image(await image.bytes()).metadata()).width).toBe(320)

        const avif = await fetch(`${origin}${variant}`, { headers: { accept: 'image/avif,image/webp' } })
        // Encoded on request, on the worker thread the executable carries.
        const upload = await fetch(`${origin}/_kay/image?src=${encodeURIComponent('/uploads/photo.png')}&w=320`, { headers: { accept: 'image/avif' } })

        expect([avif.headers.get('content-type'), avif.headers.get('vary')]).toEqual(['image/avif', 'accept'])
        expect(upload.headers.get('content-type')).toBe('image/avif')
        expect(new TextDecoder().decode((await upload.bytes()).subarray(4, 12))).toBe('ftypavif')
        expect((await fetch(`${origin}/favicon.ico`)).headers.get('content-type')).toBe('image/x-icon')
        expect((await get('/manifest.webmanifest')).status).toBe(200)
        expect((await get(font)).status).toBe(200)
        expect((await get('/sitemap.xml')).text).toContain('<loc>https://example.com/about</loc>')
        // Content entries come from what the build compiled, with nothing of src/content beside the executable.
        expect((await get('/notes/first')).text).toContain('<h1>First note</h1><h2 id="read-me"><a href="#read-me">Read me</a></h2>')
        expect((await get('/notes.xml')).text).toContain('<link>https://example.com/notes/first</link>')
        expect((await get('/tags')).text).toContain('<slot data-component="node_modules/kay-lib/src/tag.kay" data-props="[{&quot;label&quot;:1},&quot;kept&quot;]"><button class="tag">app:kept</button></slot>')
        expect((await get('/live-tags')).text).toContain('<button class="tag">app:live</button>')

        // A container's health check runs the executable again, asking the server beside it.
        const probe = async (on: string) => Bun.spawn([join(dir, 'server'), '--health'], { cwd: tmpdir(), env: { PATH: process.env.PATH, PORT: on }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exited

        expect(await probe(String(port))).toBe(0)
        expect(await probe('1')).toBe(1)
      }
      finally {
        server.kill()
        await server.exited
      }
    }
    finally {
      await rm(join(dir, '..'), { recursive: true, force: true })
    }
  }, 120_000)
})
