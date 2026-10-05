import type { BunPlugin } from 'bun'
import type { KayConfig } from '../src/config'
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { describe, expect, it } from 'bun:test'
import { ASSET_FILE, clientDir, writeAsset } from '../src/build/assets'
import { runtimeConfig, withoutPlugins } from '../src/build/runtime-config'
import { mapBundleToKay, mapStack } from '../src/build/sourcemap'
import { analyzeKayCached, transformKayCached } from '../src/build/transform'
import { loadConfig, withConfig } from '../src/config'
import { buildClient } from '../src/server/client'

const root = join(import.meta.dir, 'fixtures/islands')

// Under the checkout's node_modules, so the pages it serves resolve their dependencies.
async function scratchProject(files: Record<string, string>): Promise<string> {
  const base = join(import.meta.dir, '../node_modules/.cache')

  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'config-'))

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('kay build', () => {
  it('refuses a client build whose chunk reads a server-only global, naming the module it came from', async () => {
    const root = await scratchProject({
      // What every app has: one module holding the settings, read from the environment as it loads.
      'src/settings.ts': 'export const siteName = process.env.SITE_NAME || \'site\'\n',
      'src/counter.kay': '---\nimport { signal } from \'kay\'\nimport { siteName } from \'./settings\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {siteName} {n()}\n',
      'src/routes/index.kay': '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
    })

    try {
      await expect(buildClient(root)).rejects.toThrow(/`process` in counter-[a-z0-9]+\.js, read by src\/settings\.ts/)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('names the island\'s own fence when the read is there, and minifies as the build does', async () => {
    const root = await scratchProject({
      'src/counter.kay': '---\nimport { signal } from \'kay\'\n\nconst own = process.env.OWN\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {own} {n()}\n',
      'src/routes/index.kay': '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
    })

    try {
      await expect(buildClient(root, { minify: true })).rejects.toThrow(/`process` in counter-[a-z0-9]+\.js, read by src\/counter\.kay/)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('builds an island reading a server-only global behind a `typeof`, as a module written for both sides does', async () => {
    const root = await scratchProject({
      'src/settings.ts': 'export const dev = typeof process !== \'undefined\' && process.env.MODE === \'dev\'\n',
      'src/counter.kay': '---\nimport { signal } from \'kay\'\nimport { dev } from \'./settings\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {dev ? \'dev\' : \'\'} {n()}\n',
      'src/routes/index.kay': '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
    })

    try {
      expect((await buildClient(root)).islands).toBeDefined()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lets Tailwind see the classes written in the .class shorthand', async () => {
    const project = join(import.meta.dir, 'fixtures/tailwind')

    try {
      const client = await buildClient(project, { plugins: [tailwind] })
      const css = await Bun.file(join(client.dir, client.styles.get(join(project, 'src/routes/index.kay'))!.slice('/_kay/'.length))).text()

      for (const name of ['md\\:flex', 'w-1\\/2', 'text-red-500', 'hover\\:underline'])
        expect(css).toContain(`.${name}`)
    }
    finally {
      await rm(join(project, '.kay'), { recursive: true, force: true })
    }
  })

  it('maps each island chunk to the lines and text of its .kay source', async () => {
    const counter = join(root, 'counter.kay')
    const source = await Bun.file(counter).text()

    try {
      const client = await buildClient(root, { sourcemap: true })
      const maps = (await readdir(client.dir)).filter(file => file.endsWith('.js.map'))

      // As the server does when it first serves each; a second time changes nothing.
      await Promise.all(maps.map(async file => mapBundleToKay(join(client.dir, file))))
      await Promise.all(maps.map(async file => mapBundleToKay(join(client.dir, file))))

      const bundles = await Promise.all(maps.map(async file => await Bun.file(join(client.dir, file)).json() as { sources: string[], sourcesContent: string[], mappings: string }))
      const bundle = bundles.find(map => map.sources.some(path => path.endsWith('/counter.kay')))!
      const index = bundle.sources.findIndex(path => path.endsWith('/counter.kay'))
      const lines = sourceLines(bundle.mappings, index)

      expect(bundle.sourcesContent[index]).toBe(source)
      // `button(onClick={() => count.set(c => c + 1)}) Count {count()}` is the template's one line.
      expect(lines).toContain(source.split('\n').findIndex(line => line.startsWith('button(')))
      expect(Math.max(...lines)).toBeLessThan(source.split('\n').length)
    }
    finally {
      await rm(join(root, '.kay'), { recursive: true, force: true })
    }
  })

  it('runs the build plugins of the project on its stylesheets', async () => {
    const site = join(import.meta.dir, 'fixtures/site')
    const plugin: BunPlugin = { name: 'test', setup: build => void build.onLoad({ filter: /theme\.css$/ }, () => ({ contents: '.from-plugin { color: red }', loader: 'css' })) }

    try {
      const client = await buildClient(site, { plugins: [plugin] })
      const layout = client.styles.get(join(site, 'src/routes/_layout.kay'))!

      expect(await Bun.file(join(client.dir, layout.slice('/_kay/'.length))).text()).toContain('.from-plugin')
    }
    finally {
      await rm(join(site, '.kay/client'), { recursive: true, force: true })
    }
  })

  it('writes the files pages import, through a server fence\'s modules too, for a production server that never writes', async () => {
    const site = join(import.meta.dir, 'fixtures/site')

    try {
      const client = await buildClient(site)

      expect((await readdir(join(client.dir, 'assets'))).sort()).toEqual([expect.stringMatching(/^logo-\w+\.png$/), expect.stringMatching(/^og-\w+\.svg$/)])
    }
    finally {
      await rm(join(site, '.kay/client'), { recursive: true, force: true })
    }
  })

  it('names an asset in its URL the way a browser reads it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-asset-'))

    try {
      await Bun.write(join(dir, 'my logo#1.png'), 'png')

      const url = await writeAsset(join(dir, 'my logo#1.png'), dir)
      const name = decodeURIComponent(url.slice('/_kay/assets/'.length))

      expect(url).toMatch(/^\/_kay\/assets\/my%20logo%231-\w+\.png$/)
      expect(await Bun.file(join(clientDir(dir), 'assets', name)).text()).toBe('png')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('takes an import as an asset whatever the case of its extension', () => {
    expect(['logo.png', 'UP.PNG', 'photo.Jpg'].map(file => ASSET_FILE.test(file))).toEqual([true, true, true])
    expect(ASSET_FILE.test('notes.png.txt')).toBe(false)
  })

  it('bundles the islands for production and writes the manifest a server boots from', async () => {
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root], { stdout: 'pipe', stderr: 'pipe' })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
      const manifest = await Bun.file(join(root, '.kay/client/manifest.json')).json() as { entry: string, islands: Record<string, string[]> }
      const entryFile = join(root, '.kay/client/dist', manifest.entry.slice('/_kay/'.length))
      const entry = await Bun.file(entryFile).text()

      expect(code).toBe(0)
      expect(errors).toStartWith('built 9 islands, 0 stylesheets and 0 prerendered pages in ')
      expect(Object.keys(manifest.islands).sort()).toEqual(['counter.kay', 'greeting.kay', 'joined.kay', 'picker.kay', 'plain.kay', 'rich.kay', 'slow.kay', 'tally.kay', 'typed.kay'])
      // Minified: no line of the bundle is indented.
      expect(entry).not.toContain('\n  ')
      expect(Bun.gunzipSync(await Bun.file(`${entryFile}.gz`).bytes())).toEqual(await Bun.file(entryFile).bytes())
      expect(await Bun.file(`${entryFile}.br`).exists()).toBe(true)
    }
    finally {
      await rm(join(root, '.kay'), { recursive: true, force: true })
    }
  })
})

describe('kay.config.ts', () => {
  it('refuses a config without a default export with a message naming the fix', async () => {
    const root = await scratchProject({ 'kay.config.ts': 'export const routes = \'pages\'\n' })

    try {
      await expect(loadConfig(root)).rejects.toThrow('kay.config.ts must export its config by default')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lets options given in code win over the config, except those given as undefined', async () => {
    const root = await scratchProject({ 'kay.config.ts': 'export default { routes: \'pages\', lang: \'en\' }\n' })

    try {
      const config: KayConfig = await withConfig(root, { routes: undefined, lang: 'fr' })

      expect(config).toEqual({ routes: 'pages', lang: 'fr' })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the config\'s value for an option pages() is given as undefined', async () => {
    // A process serves one project, so the server runs in its own.
    const serve = 'import { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nconst app = new Elysia().use(await pages({ root: import.meta.dir, dev: true, routes: undefined }))\nconst response = await app.handle(new Request(\'http://localhost/\'))\n\nconsole.log(response.status, (await response.text()).includes(\'Home\'))\nprocess.exit(0)\n'
    const root = await scratchProject({ 'kay.config.ts': 'export default { routes: \'pages\' }\n', 'pages/index.kay': 'p Home\n', 'serve.ts': serve })

    try {
      const child = Bun.spawn([process.execPath, 'serve.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

      expect(output).toBe('200 true\n')
      expect(code).toBe(0)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves the build plugins out of the config a compiled server loads, with what only they imported', () => {
    expect(withoutPlugins([
      'import tailwind from \'bun-plugin-tailwind\'',
      'import { defineConfig } from \'kay/server\'',
      '',
      'export default defineConfig({',
      '  lang: \'fr\',',
      '  plugins: [tailwind],',
      '  site: \'https://example.com\',',
      '})',
      '',
    ].join('\n'))).toBe('import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({\n  lang: \'fr\',\n  \n  site: \'https://example.com\',\n})\n')

    // A factory, through a const named as the property, with a helper only it calls.
    expect(withoutPlugins([
      'import mdx, { options } from \'mdx-plugin\'',
      'import \'./side-effect\'',
      'function settings() { return options }',
      'const plugins = [mdx(settings())]',
      'const config = { plugins } satisfies object',
      'export default config',
    ].join('\n'))).toBe('import \'./side-effect\'\nconst config = {  } satisfies object\nexport default config')
  })

  it('keeps what the rest of the config uses, and a config without plugins as it is', () => {
    const source = 'import shared, { onError } from \'./shared\'\n\nexport default { plugins: [shared], onError }\n'

    expect(withoutPlugins(source)).toBe('import shared, { onError } from \'./shared\'\n\nexport default {  onError }\n')
    expect(withoutPlugins('export const plugins = []\nexport default { plugins }\n')).toBe('export const plugins = []\nexport default {  }\n')
    expect(withoutPlugins('export default { lang: \'en\' }\n')).toBeUndefined()
    // A destructuring stays while one of its names is used.
    expect(withoutPlugins('import { a } from \'x\'\nconst { p, q } = a()\nexport default { plugins: [p], onError: q }\n')).toBe('import { a } from \'x\'\nconst { p, q } = a()\nexport default {  onError: q }\n')
  })

  it('takes a plugins key however it is written, and gives up on a spread that may carry more', () => {
    expect(withoutPlugins('import tw from \'tw\'\nexport default { lang: \'en\', plugins: [tw] /* build */, site: \'x\' }\n')).toBe('export default { lang: \'en\',  site: \'x\' }\n')
    expect(withoutPlugins('import tw from \'tw\'\nexport default { \'plugins\': [tw], lang: \'en\' }\n')).toBe('export default {  lang: \'en\' }\n')
    expect(withoutPlugins('import tw from \'tw\'\nexport default { plugins() { return [tw] }, lang: \'en\' }\n')).toBe('export default {  lang: \'en\' }\n')
    expect(withoutPlugins('const base = { plugins: [] }\nexport default { ...base, plugins: [] }\n')).toBeUndefined()
    expect(withoutPlugins('export default { plugins: [ }\n')).toBeUndefined()
  })

  it('strips the config Bun loads through a symlinked project', async () => {
    const root = await scratchProject({
      'kay.config.ts': 'import stamp from \'./stamp\'\n\nexport default { plugins: [stamp], lang: \'en\' }\n',
      'stamp.ts': 'export default \'STAMP\'\n',
      'entry.ts': 'import config from \'./kay.config\'\n\nconsole.log(config)\n',
    })
    const link = `${root}-link`

    await symlink(root, link)

    try {
      const file = join(link, 'kay.config.ts')
      const build = await Bun.build({ entrypoints: [join(link, 'entry.ts')], target: 'bun', plugins: [runtimeConfig(file, withoutPlugins(await Bun.file(file).text())!)] })
      const code = await build.outputs[0]!.text()

      expect(code).not.toContain('STAMP')
      expect(code).toContain('lang: "en"')
    }
    finally {
      await rm(link, { force: true })
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('kay build without the server environment', () => {
  it('prerenders a page whose layout declares a variable the build lacks, and fails one reading it, naming it', async () => {
    const root = await scratchProject({
      'src/env.ts': 'import { t } from \'elysia\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(t.Object({ MAIL_TO: t.String() }))\n',
      'src/routes/_layout.kay': '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\nimport { env } from \'../env\'\n\nexport const send = action(t.Object({}), () => env.MAIL_TO)\n---\nslot\n',
      'src/routes/index.kay': '--- server\nexport const prerender = true\n---\np Home\n',
    })
    const build = async () => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build'], { cwd: root, env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' })
      const [report, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

      return { report, code }
    }

    try {
      const built = await build()

      expect(built.report).toContain('1 prerendered page')
      expect(built.code).toBe(0)

      await Bun.write(join(root, 'src/routes/mail.kay'), '--- server\nimport { env } from \'../env\'\n\nexport const prerender = true\n\nconst to = env.MAIL_TO\n---\np {to}\n')
      const refused = await build()

      expect(refused.report).toContain('kay: MAIL_TO does not match the environment\'s schema')
      expect(refused.code).toBe(1)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('compile cache', () => {
  it('serves an unchanged file from the cache, recompiles a changed one, and still maps its stacks', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'kay-cache-'))
    const file = join(cacheDir, 'boom.kay')
    const source = '--- server\nconst kaboom = () => {\n  throw new Error(\'boom\')\n}\nkaboom()\n---\np never\n'
    const options = { target: 'ssr', cacheDir } as const

    try {
      const compiled = await transformKayCached(source, file, options)
      const line = compiled.split('\n').findIndex(text => text.includes('throw new Error'))
      const frame = `at kaboom (${file}:${line + 1}:${compiled.split('\n')[line]!.indexOf('throw') + 1})`
      const mapped = mapStack(frame)

      expect(mapped).toBe(`at kaboom (${file}:3:3)`)
      expect(await transformKayCached(source, file, options)).toBe(compiled)
      // A cache hit registers maps that only compile when a stack needs them.
      expect(mapStack(frame)).toBe(mapped)
      expect(await transformKayCached(source.replace('never', 'changed'), file, options)).toContain('changed')
      expect(await readdir(cacheDir)).toEqual([expect.stringMatching(/-ssr\.json$/)])
    }
    finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })

  it('keeps one entry per target, hydration and root, and the analysis of a file only once it compiles', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'kay-cache-'))
    const file = join(cacheDir, 'counter.kay')
    const source = '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton.counter(onClick={() => count.set(c => c + 1)}) Count {count()}\n'

    try {
      const dom = await transformKayCached(source, file, { target: 'dom', cacheDir, root: cacheDir })
      const otherRoot = await transformKayCached(source, file, { target: 'dom', cacheDir, root: dirname(cacheDir) })

      expect(otherRoot).not.toBe(dom)
      expect(await transformKayCached(source, file, { target: 'dom', cacheDir, root: cacheDir })).toBe(dom)

      // Without a root, the working directory is the root, in the key too.
      const cwd = process.cwd()

      try {
        process.chdir(cacheDir)
        expect(await transformKayCached(source, file, { target: 'dom', cacheDir })).toBe(dom)
        process.chdir(dirname(cacheDir))
        expect(await transformKayCached(source, file, { target: 'dom', cacheDir })).toBe(otherRoot)
      }
      finally {
        process.chdir(cwd)
      }
      const ssr = await transformKayCached(source, file, { target: 'ssr', cacheDir, root: cacheDir })

      expect(ssr).not.toBe(dom)
      // Server markup of an island carries the markers hydration claims only when the page hydrates.
      expect(await transformKayCached(source, file, { target: 'ssr', hydratable: true, cacheDir, root: cacheDir })).not.toBe(ssr)

      const analysis = await analyzeKayCached(source, file, cacheDir, cacheDir)

      expect(analysis).toMatchObject({ island: 'counter.kay', classes: ['counter'], diagnostics: [] })
      expect(await analyzeKayCached(source, file, cacheDir, cacheDir)).toEqual(analysis)
      expect((await analyzeKayCached('for t of list\n  li x\n', file, cacheDir, cacheDir)).diagnostics).not.toHaveLength(0)
      expect(await analyzeKayCached(source, file, cacheDir, cacheDir)).toEqual(analysis)
      expect((await readdir(cacheDir)).sort()).toEqual([expect.stringMatching(/-analysis\.json$/), expect.stringMatching(/-dom\.json$/), expect.stringMatching(/-ssr-hydratable\.json$/), expect.stringMatching(/-ssr\.json$/)])
    }
    finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// The 0-based lines of one source a v3 map points at, decoded here rather than by kay so a mistake both ways round cannot pass.
function sourceLines(mappings: string, source: number): number[] {
  const fields = [0, 0, 0, 0, 0]
  const lines: number[] = []

  for (const line of mappings.split(';')) {
    fields[0] = 0

    for (const segment of line.split(',').filter(text => text !== '')) {
      const values: number[] = []
      let value = 0
      let shift = 0

      for (const char of segment) {
        const digit = BASE64.indexOf(char)

        value += (digit & 31) << shift
        shift += 5

        if (digit & 32)
          continue

        values.push(value & 1 ? -(value >>> 1) : value >>> 1)
        value = 0
        shift = 0
      }

      for (const [index, delta] of values.entries())
        fields[index]! += delta

      if (values.length > 1 && fields[1] === source)
        lines.push(fields[2]!)
    }
  }

  return lines
}
