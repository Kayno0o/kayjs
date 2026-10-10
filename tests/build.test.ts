import type { BunPlugin } from 'bun'
import type { KayConfig } from '../src/config'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { describe, expect, it } from 'bun:test'
import { ASSET_FILE, clientDir, writeAsset } from '../src/build/assets'
import { buildClient } from '../src/build/client'
import { formatSizeReport } from '../src/build/report'
import { runtimeConfig, withoutPlugins } from '../src/build/runtime-config'
import { mapBundleToKay, mapStack } from '../src/build/sourcemap'
import { analyzeKayCached, transformKayCached } from '../src/build/transform'
import { loadConfig, withConfig } from '../src/config'

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

  it('refuses a client build whose island reaches a builtin a browser lacks, naming the imports leading there', async () => {
    const root = await scratchProject({
      'src/db.ts': 'import { Database } from \'bun:sqlite\'\n\nexport const db = new Database(\':memory:\')\n',
      // A helper the island needs, beside a query it does not: the module opens the database as it loads all the same.
      'src/links.ts': 'import { db } from \'./db\'\n\nexport const link = (id: number) => `/items/${id}`\nexport const count = () => db.query(\'select 1\').get()\n',
      'src/counter.kay': '---\nimport { signal } from \'kay\'\nimport { link } from \'./links\'\n\nconst n = signal(0)\n---\na(href={link(n())} onClick={() => n.set(n() + 1)}) {n()}\n',
      'src/routes/index.kay': '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
    })

    try {
      await expect(buildClient(root)).rejects.toThrow('src/counter.kay -> src/links.ts -> src/db.ts -> bun:sqlite')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves the islands of a kay project nested inside to that project, whose API modules are its own', async () => {
    const island = (api: string) => `---\nimport { signal, socket } from 'kay'\nimport live from '${api}'\n\nconst n = signal(0)\nconst feed = socket(live, '/')\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {feed.status()} {n()}\n`
    const root = await scratchProject({
      'src/counter.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {n()}\n',
      'src/routes/index.kay': '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
      // An example app beside the outer one's sources: its island reaches a server module the outer project serves no API from.
      'examples/chat/kay.config.ts': 'export default {}\n',
      'examples/chat/src/api/live.ts': 'import { Database } from \'bun:sqlite\'\nimport { Elysia } from \'elysia\'\n\nconst db = new Database(\':memory:\')\n\nexport default new Elysia().ws(\'/\', { message: ws => void ws.send(String(db.query(\'select 1\').get())) })\n',
      'examples/chat/src/live.kay': island('./api/live'),
    })

    try {
      expect(Object.keys((await buildClient(root)).islands)).toEqual(['src/counter.kay'])
      expect(Object.keys((await buildClient(join(root, 'examples/chat'))).islands)).toEqual(['src/live.kay'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a client build where an island builds a schema with kay\'s t, naming the module taking it from kay', async () => {
    const root = await scratchProject({
      // A schema module shared by an action and an island's own check.
      'src/schemas.ts': 'import { t } from \'kay\'\n\nexport const title = t.String({ minLength: 1 })\nexport const longest = 200\n',
      'src/counter.kay': '---\nimport { signal } from \'kay\'\nimport { longest, title } from \'./schemas\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {longest} {String(title)} {n()}\n',
      'src/routes/index.kay': '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
    })

    try {
      await expect(buildClient(root, { minify: true })).rejects.toThrow('an island imports src/schemas.ts, which takes it from \'kay\'')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('builds an island whose modules take t from kay as a type, the page building its schema in its server fence', async () => {
    const root = await scratchProject({
      'src/schemas.ts': 'import type { t as schema } from \'kay\'\n\nexport const longest: number = 200\nexport type Builder = typeof schema\n',
      'src/counter.kay': '---\nimport { signal } from \'kay\'\nimport { longest } from \'./schemas\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {longest} {n()}\n',
      'src/routes/index.kay': '--- server\nimport { t } from \'kay\'\n\nexport const add = action(t.Object({ title: t.String({ maxLength: 20 }) }), () => 1)\n---\n---\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
    })

    try {
      await buildClient(root, { minify: true })
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
      // `button(onClick={() => count.set(count + 1)}) Count {count}` is the template's one line.
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
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, '--no-check'], { stdout: 'pipe', stderr: 'pipe' })
      const [report, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      const manifest = await Bun.file(join(root, '.kay/client/manifest.json')).json() as { entry: string, islands: Record<string, string[]> }
      const entryFile = join(root, '.kay/client/dist', manifest.entry.slice('/_kay/'.length))
      const entry = await Bun.file(entryFile).text()

      expect(code).toBe(0)
      expect(report).toStartWith('built 9 islands, 0 stylesheets and 0 prerendered pages in ')
      expect(Object.keys(manifest.islands).sort()).toEqual(['counter.kay', 'greeting.kay', 'joined.kay', 'picker.kay', 'plain.kay', 'rich.kay', 'slow.kay', 'tally.kay', 'typed.kay'])
      // Minified: no line of the bundle is indented.
      expect(entry).not.toContain('\n  ')
      expect(Bun.gunzipSync(await Bun.file(`${entryFile}.gz`).bytes())).toEqual(await Bun.file(entryFile).bytes())
      expect(await Bun.file(`${entryFile}.br`).exists()).toBe(true)

      // The runtime and the entry's own code are one chunk, which every island and the page swap import alone: a page loads it, then one chunk per island.
      const swap = (await readdir(dirname(entryFile))).find(file => file.startsWith('page-swap-') && file.endsWith('.js'))!

      expect(Object.values(manifest.islands).filter(chunks => chunks.length !== 2 || chunks[1] !== manifest.entry)).toEqual([])
      expect([...(await Bun.file(join(dirname(entryFile), swap)).text()).matchAll(/from\s*"\.\/([^"]+)"/g)].map(match => `/_kay/${match[1]}`)).toEqual([manifest.entry])
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
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', '--no-check'], { cwd: root, env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' })
      const [report, code] = await printed(child)

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

describe('kay build checks the project first', () => {
  const tsconfig = JSON.stringify({
    compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
    include: ['src', '.kay/types'],
  })
  const build = async (root: string, ...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
    const [report, code] = await printed(child)

    return { report, code }
  }

  it('builds nothing from a project kay check refuses, and builds it with --no-check', async () => {
    const root = await scratchProject({ 'tsconfig.json': tsconfig, 'src/routes/index.kay': 'a(href="/nowhere") Lost\n' })

    try {
      const refused = await build(root)

      expect(refused.report).toContain('/nowhere')
      expect(refused.report).toContain('kay build: nothing built, as kay check found the problems above; --no-check builds anyway')
      expect(refused.code).toBe(1)
      expect(await Bun.file(join(root, '.kay/client/manifest.json')).exists()).toBe(false)

      const built = await build(root, '--no-check')

      expect(built.report).toStartWith('built 0 islands')
      expect(built.code).toBe(0)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('keeps the last build when the check or the build fails, runs no page while the check fails, and recovers from an interrupted run', async () => {
    const root = await scratchProject({ 'tsconfig.json': tsconfig })
    const ran = join(root, 'ran')
    // A prerendered page that records it ran, which the build does once the check passed.
    const page = async (text: string, code = '') => Bun.write(join(root, 'src/routes/index.kay'), `--- server\nexport const prerender = true\nawait Bun.write(${JSON.stringify(ran)}, '${text}')\n${code}---\np ${text}\n`)
    const prerendered = join(root, '.kay/client/pages/index.html')
    const output = join(root, '.kay/client')
    const previous = join(root, '.kay/client-previous')

    try {
      await page('First')
      expect((await build(root)).code).toBe(0)
      expect(await Bun.file(prerendered).text()).toContain('First')

      // The page changes as a broken one comes along, which the check refuses.
      await page('Second')
      await Bun.write(join(root, 'src/routes/lost.kay'), 'a(href="/nowhere") Lost\n')

      expect((await build(root)).code).toBe(1)
      expect(await Bun.file(prerendered).text()).toContain('First')
      expect(await Bun.file(ran).text()).toBe('First')
      expect(existsSync(previous)).toBe(false)

      // A run interrupted mid-build leaves the last build aside and a partial one in its place.
      await rename(output, previous)
      await Bun.write(join(output, 'partial'), '')

      expect((await build(root)).code).toBe(1)
      expect(await Bun.file(prerendered).text()).toContain('First')
      expect(existsSync(join(output, 'partial'))).toBe(false)

      await Bun.write(join(root, 'src/routes/lost.kay'), 'a(href="/") Found\n')

      expect((await build(root)).code).toBe(0)
      expect(await Bun.file(prerendered).text()).toContain('Second')
      expect(existsSync(previous)).toBe(false)

      // The check passes and the build fails, as the page throws once it renders.
      await page('Third', 'if (Date.now() > 0)\n  throw new Error(\'Feed down\')\n')

      const failed = await build(root)

      expect(failed.report).toContain('Feed down')
      expect(failed.code).toBe(1)
      expect(await Bun.file(prerendered).text()).toContain('Second')
      expect(existsSync(previous)).toBe(false)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('checks with the tsconfig -p names, which --no-check does not take', async () => {
    const root = await scratchProject({ 'tsconfig.app.json': tsconfig, 'src/routes/index.kay': 'p Home\n' })

    try {
      const built = await build(root, '-p', 'tsconfig.app.json')

      expect(built.report).toStartWith('built 0 islands')
      expect(built.code).toBe(0)

      const refused = await build(root, '-p', 'tsconfig.app.json', '--no-check')

      expect(refused.report).toContain('kay: -p names the tsconfig the build checks with, so it does not go with --no-check')
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
      expect((await analyzeKayCached('for of list\n  li x\n', file, cacheDir, cacheDir)).diagnostics).not.toHaveLength(0)
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

// What a command printed, its reports on stdout then its problems on stderr, and its exit code.
async function printed(child: { stdout: ReadableStream<Uint8Array>, stderr: ReadableStream<Uint8Array>, exited: Promise<number> }): Promise<[string, number]> {
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return [stdout + stderr, code]
}

describe('the size report', () => {
  it('weighs the entry and what each island loads beyond it, the heaviest first, and breaks them down by module', async () => {
    const root = await scratchProject({
      'src/data.ts': `export const words = ${JSON.stringify(Array.from({ length: 400 }, (_, index) => `word-${index}-${(index * 7919).toString(36)}`))}\n`,
      'src/big.kay': '---\nimport { signal } from \'kay\'\nimport { words } from \'./data\'\n\nconst shown = signal(0)\n---\nbutton(type="button" onClick={() => shown.set(shown() + 1)}) {words[shown()]}\n',
      'src/small.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {n()}\n',
      'src/routes/index.kay': '---\nimport Big from \'../big.kay\'\nimport Small from \'../small.kay\'\n---\nBig\nSmall\n',
    })

    try {
      const { report, dir, entry, entryImports } = await buildClient(root, { minify: true, report: 'modules' })
      const gzip = async (url: string) => Bun.gzipSync(await Bun.file(join(dir, url.replace('/_kay/', ''))).bytes(), { level: 9 }).length
      const entryGzip = (await Promise.all([entry!, ...entryImports].map(gzip))).reduce((sum, size) => sum + size, 0)

      expect(report!.entry!.size.gzip).toBe(entryGzip)
      expect(report!.entry!.modules!.map(module => module.name)).toContain('kay/src/runtime/dom.ts')
      expect(report!.islands.map(island => island.file)).toEqual(['src/big.kay', 'src/small.kay'])
      expect(report!.islands[0]!.size.gzip).toBeGreaterThan(report!.islands[1]!.size.gzip)
      expect(report!.islands[0]!.modules![0]).toEqual({ name: 'src/data.ts', bytes: expect.any(Number) })

      const printed = formatSizeReport(report!)

      expect(printed).toMatch(/^ {2}entry, loaded by every page with an island {2}\d+\.\d KB \(\d+\.\d KB\)$/m)
      expect(printed).toMatch(/^ {2}src\/big\.kay +\+\d+\.\d KB \(\d+\.\d KB\)\n {6}src\/data\.ts {2}\d+\.\d KB$/m)
      // An island holding only itself is not broken down.
      expect(printed.split('\n').at(-1)).toMatch(/^ {2}src\/small\.kay +\+/)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports no JavaScript for a site with no island', () => {
    expect(formatSizeReport({ islands: [] })).toBe('no JavaScript: no page has an island')
  })
})
