import type { Subprocess } from 'bun'
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { parse, stringify } from 'devalue'
import { buildClient } from '../src/build/client'
import { check } from '../src/check'
import { formatFiles } from '../src/format'
import { createProject } from '../src/new'

const repo = join(import.meta.dir, '..')
const LISTENING = /localhost:(\d+)/
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

// Lints as `bun run lint` does, through keslint and the eslint it runs under Node, as JSON.
async function lint(dir: string, path: string): Promise<{ filePath: string, messages: { ruleId: string | null, line: number }[] }[]> {
  const child = Bun.spawn([join(dir, 'node_modules/.bin/keslint'), '--format', 'json', path], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  expect(stderr).toBe('')

  return JSON.parse(stdout) as { filePath: string, messages: { ruleId: string | null, line: number }[] }[]
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
      expect(await Bun.file(join(dir, 'my app {x}/src/components/header.kay')).text()).toContain('(href="/") my-app-x\n')
      expect(await Bun.file(join(dir, 'my app {x}/kay.config.ts')).text()).toContain('seo: { name: \'my-app-x\', titleTemplate: \'%s | my-app-x\'')
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
      const manifest = await Bun.file(join(dir, 'package.json')).json() as { dependencies: Record<string, string>, devDependencies: Record<string, string>, scripts: Record<string, string> }

      expect(files).toContain('src/routes/index.kay')
      // The container runs the one executable `kay build --compile` makes.
      expect(files).toEqual(expect.arrayContaining(['Dockerfile', 'compose.prod.yaml', 'src/components/accent-picker.kay']))
      expect(manifest.scripts.compile).toBe('kay build --compile server')
      expect(await Bun.file(join(dir, 'Dockerfile')).text()).toContain('RUN bun run compile')
      expect(await Bun.file(join(dir, 'Dockerfile')).text()).toContain('HEALTHCHECK --interval=30s --timeout=6s CMD ["./server", "--health"]')
      expect(Object.keys(manifest.devDependencies)).toEqual(['@iconify-json/tabler', '@kaynooo/eslint', '@types/bun', 'bun-plugin-tailwind', 'tailwindcss'])
      expect(await Bun.file(join(dir, '.npmrc')).text()).toBe('@kaynooo:registry=https://git.kaynooo.fr/api/packages/kaynooo/npm/\n')
      expect(manifest.dependencies.kay).toBe('^1.0.0')
      expect(await Bun.file(join(dir, 'src/components/header.kay')).text()).toContain('(href="/") my-app\n')
      // As strict as kay itself, and checked, linted and tested on every push.
      expect(await Bun.file(join(dir, 'tsconfig.json')).json()).toEqual({ extends: 'kay/tsconfig.json' })
      expect(((await Bun.file(join(repo, 'src/tsconfig.app.json')).json()) as { compilerOptions: Record<string, unknown> }).compilerOptions).toMatchObject({ strict: true, noFallthroughCasesInSwitch: true, noImplicitOverride: true, noUncheckedIndexedAccess: true })
      expect(await Bun.file(join(dir, '.forgejo/workflows/test.yml')).text()).toContain('run: bun run check\n\n      # After the check, which writes the types the lint of .kay files reads.\n      - name: Lint\n        run: bun run lint\n\n      - name: Test\n        run: bun run test\n')

      await installKay(dir)

      // Stricter than kay itself: its source fails this flag, its declarations must not.
      const scaffolded = await Bun.file(join(dir, 'tsconfig.json')).text()
      const tsconfig = JSON.parse(scaffolded) as { compilerOptions: Record<string, unknown> }

      await Bun.write(join(dir, 'tsconfig.json'), JSON.stringify({ ...tsconfig, compilerOptions: { ...tsconfig.compilerOptions, exactOptionalPropertyTypes: true } }))
      expect(await check(dir)).toEqual([])
      expect((await formatFiles([join(dir, 'src')], { write: false })).changed).toEqual([])
      // The scaffolded tsconfig, as lint reads every file of the project.
      await Bun.write(join(dir, 'tsconfig.json'), scaffolded)
      expect((await lint(dir, '.')).flatMap(result => result.messages)).toEqual([])

      // A page's server fence is linted with the project's types, at its .kay line.
      await Bun.write(join(dir, 'src/routes/later.kay'), '--- server\nBun.write(\'later.txt\', \'later\')\n---\np Later\n')
      expect(await check(dir)).toEqual([])
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
      const files = await createProject(dir, { kay: '^1.0.0', template: 'site' })
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
      expect(await check(dir)).toEqual([])
      expect((await lint(dir, '.')).flatMap(result => result.messages)).toEqual([])

      const build = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', '--static'], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, SITE_URL: 'https://pages.example', SITE_BASE: '/me/my-site' } })
      const [report, code] = await Promise.all([new Response(build.stderr).text(), build.exited])

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
      const files = await createProject(dir, { kay: '^1.0.0', template: 'app' })

      expect(files).toEqual(expect.arrayContaining(['.env', '.env.example', '.env.test', 'compose.dev.yaml', 'migrations/0001_member.sql', 'pg-orm.config.ts', 'src/db/index.ts', 'src/routes/account/_guard.ts', 'src/api/online.ts', 'tests/account.test.ts', 'tests/database.ts', 'tests/members.test.ts']))
      expect((await stat(join(dir, '.env'))).mode & 0o777).toBe(0o600)
      expect(await Bun.file(join(dir, '.env')).text()).toMatch(/^SESSION_SECRET=[0-9a-f]{64}\nDATABASE_URL=postgres:\/\/app:app@127\.0\.0\.1:5433\/app\nCOMPOSE_FILE=compose\.dev\.yaml\n$/)
      expect(await Bun.file(join(dir, '.gitignore')).text()).toContain('.env')
      expect(await Bun.file(join(dir, 'compose.prod.yaml')).text()).toContain('SESSION_SECRET: ${SESSION_SECRET:?set SESSION_SECRET}')

      await installKay(dir)
      expect(await check(dir)).toEqual([])
      expect((await formatFiles([join(dir, 'src')], { write: false })).changed).toEqual([])
      expect((await lint(dir, '.')).flatMap(result => result.messages)).toEqual([])

      // Signs in through the action and lands in the guarded section, reads a seeded member, and counts the visitors online over the websocket, each test file on a database of its own.
      // They need a Postgres the test user may create databases on, which CI always has.
      if (TEST_DATABASE_URL || process.env.CI) {
        const tests = Bun.spawn([process.execPath, 'run', 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...TEST_DATABASE_URL && { DATABASE_URL: TEST_DATABASE_URL } } })
        const [report, code] = await Promise.all([new Response(tests.stderr).text(), tests.exited])

        expect(report).toContain('5 pass')
        expect(code).toBe(0)
      }

      expect(Object.keys((await buildClient(dir)).islands)).toEqual(['src/components/accent-picker.kay', 'src/components/counter.kay', 'src/components/online.kay'])
    }
    finally {
      await rm(join(dir, '..'), { recursive: true, force: true })
    }
  }, 30_000)

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
        'src/routes/about.kay': '--- server\nexport const prerender = true\n---\np About\n',
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
        'src/routes/tags.kay': '---\nimport Tag from \'kay-lib/tag.kay\'\n---\n--- server\nexport const prerender = true\n---\nTag(label="kept")\n',
        'src/routes/live-tags.kay': '---\nimport Tag from \'kay-lib/tag.kay\'\n---\nTag(label="live")\n',
        // A build plugin reading a file beside it as it loads, as a native binding does: the executable must not load it.
        'node_modules/build-stamp/package.json': JSON.stringify({ name: 'build-stamp', version: '1.0.0', type: 'module', exports: { types: './index.d.ts', default: './index.js' } }),
        'node_modules/build-stamp/index.d.ts': 'declare const stamp: () => import(\'bun\').BunPlugin\nexport default stamp\n',
        'node_modules/build-stamp/index.js': 'import { readFileSync } from \'node:fs\'\nimport { join } from \'node:path\'\n\nconst binding = readFileSync(join(import.meta.dir, \'binding.txt\'), \'utf8\')\n\nexport default () => ({ name: binding, setup() {} })\n',
        'node_modules/build-stamp/binding.txt': 'stamp',
        'kay.config.ts': 'import stamp from \'build-stamp\'\nimport { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ plugins: [stamp()], lang: \'en\', site: \'https://example.com\', favicon: \'src/favicon.png\', fonts: [{ family: \'Display\', src: \'src/display.woff2\' }], settings: { \'kay-lib\': \'./src/ui-settings.ts\' } })\n',
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
      const [report, code] = await Promise.all([new Response(build.stderr).text(), build.exited])

      expect(report).toContain('compiled server in ')
      expect(code).toBe(0)
      await rm(join(dir, 'node_modules/build-stamp'), { recursive: true })

      // Run from elsewhere, with nothing of the project to read.
      const server = Bun.spawn([join(dir, 'server')], { cwd: tmpdir(), env: { PATH: process.env.PATH, PORT: '0' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

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
        const fonts = (/<link rel="stylesheet" href="(\/_kay\/assets\/fonts-[^"]+)">/).exec(home.text)![1]!
        const image = await fetch(`${origin}${variant}`)

        expect(image.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
        expect((await new Bun.Image(await image.bytes()).metadata()).width).toBe(320)
        expect((await fetch(`${origin}/favicon.ico`)).headers.get('content-type')).toBe('image/x-icon')
        expect((await get('/manifest.webmanifest')).status).toBe(200)
        expect((await get(fonts)).text).toContain('@font-face{font-family:"Display"')
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
