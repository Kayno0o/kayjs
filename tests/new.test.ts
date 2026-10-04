import type { Subprocess } from 'bun'
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { parse, stringify } from 'devalue'
import { check } from '../src/check'
import { formatFiles } from '../src/format'
import { createProject } from '../src/new'
import { buildClient } from '../src/server/client'

const repo = join(import.meta.dir, '..')
const LISTENING = /localhost:(\d+)/

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
        'src/routes/echo.kay': '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const shout = action(t.Object({ text: t.String() }), ({ text }) => text.toUpperCase())\n---\np Echo\n',
        'src/routes/admin/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ deny }) => deny(403, \'Admins only\'))\n',
        'src/routes/admin/index.kay': 'p Secret\n',
        'src/routes/photo.kay': '---\nimport { image } from \'kay/image\'\nimport hero from \'../hero.png\'\n---\nimg({...image(hero)} alt="Hero")\n',
        'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ lang: \'en\', site: \'https://example.com\', favicon: \'src/favicon.png\', fonts: [{ family: \'Display\', src: \'src/display.woff2\' }] })\n',
      }).map(async ([path, content]) => Bun.write(join(dir, path), content)))
      // Images, the favicon and fonts are read from the project at build time only: the executable serves what the build made of them.
      await Promise.all([
        Bun.write(join(dir, 'src/hero.png'), Bun.file(join(repo, 'tests/fixtures/images/src/hero.png'))),
        Bun.write(join(dir, 'src/favicon.png'), Bun.file(join(repo, 'tests/fixtures/seo/src/favicon.png'))),
        Bun.write(join(dir, 'src/display.woff2'), Bun.file(join(repo, 'tests/fixtures/seo/src/fonts/display.woff2'))),
      ])

      const build = Bun.spawn([process.execPath, join(repo, 'src/cli.ts'), 'build', '--compile', 'server'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
      const [report, code] = await Promise.all([new Response(build.stderr).text(), build.exited])

      expect(report).toContain('compiled server in ')
      expect(code).toBe(0)

      // Run from elsewhere, with nothing of the project to read.
      const server = Bun.spawn([join(dir, 'server')], { cwd: tmpdir(), env: { PATH: process.env.PATH, PORT: '0' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

      try {
        const origin = `http://localhost:${await listeningPort(server)}`
        const get = async (path: string) => {
          const response = await fetch(`${origin}${path}`)

          return { status: response.status, text: await response.text() }
        }
        const home = await get('/')
        const entry = (/<script type="module" src="([^"]+)"/).exec(home.text)![1]!
        const badges = await get('/badges')
        const about = await fetch(`${origin}/about`, { headers: { 'accept-encoding': 'br' } })
        const call = await fetch(`${origin}/_kay/action/src/routes/echo.kay/shout`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'origin': origin }, body: stringify({ text: 'hi' }) })

        expect(home.text).toContain('<h1>Hello from the server</h1>')
        expect((await get(entry)).status).toBe(200)
        expect(await get('/robots.txt')).toEqual({ status: 200, text: 'User-agent: *\n' })
        // The copy `kay build` prerendered and compressed, not a render.
        expect(about.headers.get('etag')).toEndWith('-br"')
        expect(await about.text()).toContain('<p>About</p>')
        expect(badges.text).toContain('<ul class="badges"><li><i class="dot"></i>OUT</li></ul>')
        expect(badges.text).toContain('<slot data-component="src/components/tally.kay" data-props="[{}]"><!--[--><ul class="badges"><li><!--[--><i class="dot"></i><!--]--><!--[-->IN<!--]--></li></ul><!--]--><button>0</button></slot>')
        expect(parse(await call.text())).toBe('HI')
        expect(await get('/admin')).toEqual({ status: 403, text: 'Admins only' })
        expect((await get('/missing')).text).toContain('<h1>Nothing here</h1>')

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
