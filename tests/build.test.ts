import type { BunPlugin } from 'bun'
import type { BuildOptions, BuildResult } from '../src/build/pipeline'
import type { KayConfig } from '../src/config'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { describe, expect, it } from 'bun:test'
import { ASSET_FILE, clientDir, outputDir, writeAsset } from '../src/build/assets'
import { buildClient } from '../src/build/client'
import { writeIfChanged } from '../src/build/files'
import { formatSizeReport } from '../src/build/report'
import { anchorModule } from '../src/build/runtime-chunk'
import { runtimeConfig, withoutPlugins } from '../src/build/runtime-config'
import { describeThrown, mapBundleToKay, mapStack } from '../src/build/sourcemap'
import { analyzeKayCached, transformKayCached } from '../src/build/transform'
import { loadConfig, withConfig } from '../src/config'
import { projectPaths } from '../src/project'
import { scratchDir } from './scratch'

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
      'src/schemas.ts': 'import { s } from \'kay\'\n\nexport const title = s.String({ minLength: 1 })\nexport const longest = 200\n',
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
      'src/schemas.ts': 'import type { s as schema } from \'kay\'\n\nexport const longest: number = 200\nexport type Builder = typeof schema\n',
      'src/counter.kay': '---\nimport { signal } from \'kay\'\nimport { longest } from \'./schemas\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {longest} {n()}\n',
      'src/routes/index.kay': '--- server\nimport { s } from \'kay\'\n\nexport const add = action(s.Object({ title: s.String({ maxLength: 20 }) }), () => 1)\n---\n---\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
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
      await rm(outputDir(site), { recursive: true, force: true })
    }
  })

  it('puts the stylesheets of a collection\'s components in the pages rendering its entries, and only there', async () => {
    const project = join(import.meta.dir, 'fixtures/collection-styles')

    try {
      const client = await buildClient(project)
      const markers = async (route: string) => {
        const css = await Bun.file(join(client.dir, client.styles.get(join(project, 'src/routes', route))!.slice('/_kay/'.length))).text()

        return [...css.matchAll(/\.([a-z]+)-marker/g)].map(match => match[1])
      }

      // Neither the component the content config only passes along, nor the stylesheet its server module imports.
      expect(await markers('posts/[slug].kay')).toEqual(['page', 'chart'])
      expect(await markers('notes/[slug].kay')).toEqual(['page', 'tabs'])
      expect(await markers('index.kay')).toEqual(['page'])
    }
    finally {
      await rm(join(project, '.kay'), { recursive: true, force: true })
    }
  })

  it('puts the stylesheets of the components and the stylesheets a server fence imports in the page, and none of its modules\'', async () => {
    // In the checkout, where `kay` resolves, rather than under node_modules, whose components the stylesheet build never follows.
    const project = await scratchDir('server-styles-')
    const files = {
      'src/layout.kay': '---\nimport \'./layout.css\'\n---\nmain\n  slot\n',
      'src/layout.css': '.layout-marker { color: red }\n',
      'src/page.css': '.page-marker { color: red }\n',
      'src/data.ts': 'import \'./data.css\'\n\nexport const title = \'Home\'\n',
      'src/data.css': '.data-marker { color: red }\n',
      'src/routes/index.kay': '--- server\nimport Layout from \'../layout.kay\'\nimport { title } from \'../data\'\nimport \'../page.css\'\n---\nLayout\n  h1 {title}\n',
    }

    await Promise.all(Object.entries(files).map(async ([file, content]) => Bun.write(join(project, file), content)))

    try {
      const client = await buildClient(project)
      const css = await Bun.file(join(client.dir, client.styles.get(join(project, 'src/routes/index.kay'))!.slice('/_kay/'.length))).text()

      expect([...css.matchAll(/\.([a-z]+)-marker/g)].map(match => match[1]).toSorted()).toEqual(['layout', 'page'])
    }
    finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it('writes the files pages import, through a server fence\'s modules too, for a production server that never writes', async () => {
    const site = join(import.meta.dir, 'fixtures/site')

    try {
      const client = await buildClient(site)

      // Beside the worker kay's script solves an action's proof-of-work in.
      expect((await readdir(join(client.dir, 'assets'))).sort()).toEqual([expect.stringMatching(/^logo-\w+\.png$/), expect.stringMatching(/^og-\w+\.svg$/), expect.stringMatching(/^work-worker-\w+\.js$/)])
    }
    finally {
      await rm(outputDir(site), { recursive: true, force: true })
    }
  })

  it('ships the files islands and packages point at with new URL, a script as a worker of its own, and opens the policy to what they run', async () => {
    const project = await scratchDir('workers-')
    const files: Record<string, string> = {
      // As an emscripten build with threads ships: the module starts itself as its worker and names its wasm bare.
      'node_modules/threads/package.json': JSON.stringify({ name: 'threads', type: 'module', exports: './index.js' }),
      'node_modules/threads/index.js': 'export const start = () => new Worker(new URL("index.js", import.meta.url), { type: "module" })\nexport const wasm = () => new URL("threads.wasm", import.meta.url)\nexport const missing = () => new URL("./missing.js", import.meta.url)\n',
      // As qr-scanner ships: a chunk loaded on demand starts its worker from a blob.
      'node_modules/scanner/package.json': JSON.stringify({ name: 'scanner', type: 'module', exports: './index.js' }),
      'node_modules/scanner/index.js': 'export const scan = async () => (await import("./worker.js")).start()\n',
      'node_modules/scanner/worker.js': 'export const start = () => new Worker(URL.createObjectURL(new Blob(["onmessage = () => {}"])))\n',
      // A worker gets the stubs and the stylesheet handling islands get.
      'src/echo.ts': 'import notes from \'./api/notes\'\nimport \'./echo.css\'\n\npostMessage([new URL(\'./add.wasm\', import.meta.url).href, String(notes)])\n',
      'src/echo.css': 'p { color: red }\n',
      'src/api/notes.ts': 'export default \'server only\'\n',
      'src/data/one.json': '{}\n',
      'src/commented.ts': 'postMessage(1)\n',
      // Each left as written: a directory, an absolute path, a template with a part, and a call a comment shows.
      'src/others.ts': '// new Worker(new URL("./commented.ts", import.meta.url))\nexport const others = (name: string) => [new URL("./data", import.meta.url), new URL("/abs.js", import.meta.url), new URL(`./${name}.js`, import.meta.url)]\n',
      'src/lab.kay': '---\nimport { scan } from \'scanner\'\nimport { missing, start, wasm } from \'threads\'\nimport add from \'./add.wasm\'\nimport { others } from \'./others\'\n\nonMount(() => {\n  others(\'x\')\n  new Worker(new URL(\'./echo.ts\', import.meta.url), { type: \'module\' })\n  start()\n  void scan()\n  void WebAssembly.instantiateStreaming(fetch(add))\n  void fetch(wasm())\n  void fetch(missing())\n})\n---\np lab\n',
      'src/routes/index.kay': '---\nimport Lab from \'../lab.kay\'\n---\nLab\n',
    }

    await Promise.all([
      ...Object.entries(files).map(async ([file, content]) => Bun.write(join(project, file), content)),
      Bun.write(join(project, 'src/add.wasm'), Bun.file(join(import.meta.dir, 'fixtures/workers/src/add.wasm'))),
      Bun.write(join(project, 'node_modules/threads/threads.wasm'), Bun.file(join(import.meta.dir, 'fixtures/workers/src/add.wasm'))),
    ])

    try {
      const client = await buildClient(project)
      const assets = (await readdir(join(client.dir, 'assets'))).sort()
      const island = await Bun.file(join(client.dir, client.islands['src/lab.kay']!.find(url => url.startsWith('/_kay/lab-'))!.slice('/_kay/'.length))).text()
      const echo = await Bun.file(join(client.dir, 'assets', assets.find(file => file.startsWith('echo-'))!)).text()
      const threads = await Bun.file(join(client.dir, 'assets', assets.find(file => file.startsWith('index-'))!)).text()

      expect(assets).toEqual([expect.stringMatching(/^add-\w+\.wasm$/), expect.stringMatching(/^echo-\w+\.js$/), expect.stringMatching(/^index-\w+\.js$/), expect.stringMatching(/^threads-\w+\.wasm$/), expect.stringMatching(/^work-worker-\w+\.js$/)])
      // Relative to the chunk, so the URLs hold under any base.
      expect(island).toMatch(/new URL\("\.\/assets\/echo-\w+\.js", import\.meta\.url\)/)
      expect(island).toMatch(/new URL\("\.\/assets\/index-\w+\.js", import\.meta\.url\)/)
      expect(island).toMatch(/new URL\("\.\/assets\/threads-\w+\.wasm", import\.meta\.url\)/)
      expect(island).toContain('new URL("./missing.js", import.meta.url)')
      expect(echo).toMatch(/new URL\("\.\/add-\w+\.wasm", import\.meta\.url\)/)
      expect(echo).not.toContain('server only')
      expect(island).toContain('new URL("./data", import.meta.url)')
      expect(island).toContain('new URL("/abs.js", import.meta.url)')
      // The worker a module starts from itself is its own bundle.
      expect(threads).toContain('new URL(import.meta.url, import.meta.url)')
      expect(client.directives).toEqual({ 'script-src': ['\'wasm-unsafe-eval\''], 'worker-src': ['\'self\'', 'blob:'] })
    }
    finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it('fails the build on a worker starting its starter again, and on one that does not build, naming the file and position', async () => {
    const project = await scratchDir('worker-failures-')
    const failure = async () => {
      try {
        await buildClient(project)
      }
      catch (error) {
        return (error as AggregateError).errors.map(String).join('\n')
      }

      return ''
    }
    const lab = (worker: string) => `---\nonMount(() => {\n  new Worker(new URL('./${worker}', import.meta.url), { type: 'module' })\n})\n---\np lab\n`

    try {
      await Promise.all([
        Bun.write(join(project, 'src/ping.ts'), 'new Worker(new URL("./pong.ts", import.meta.url))\n'),
        Bun.write(join(project, 'src/pong.ts'), 'new Worker(new URL("./ping.ts", import.meta.url))\n'),
        Bun.write(join(project, 'src/broken.ts'), 'postMessage(1)\nconst = 2\n'),
        Bun.write(join(project, 'src/lab.kay'), lab('ping.ts')),
        Bun.write(join(project, 'src/routes/index.kay'), '---\nimport Lab from \'../lab.kay\'\n---\nLab\n'),
      ])
      expect(await failure()).toMatch(/the worker \S+\/ping\.ts starts itself again through \S+\/pong\.ts/)

      await Bun.write(join(project, 'src/lab.kay'), lab('broken.ts'))
      expect(await failure()).toMatch(/the worker \S+\/broken\.ts failed to build:\n\S+\/broken\.ts:2:\d+: /)
    }
    finally {
      await rm(project, { recursive: true, force: true })
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
      const manifest = await Bun.file(join(outputDir(root), 'manifest.json')).json() as { entry: string, islands: Record<string, string[]> }
      const entryFile = join(outputDir(root), 'dist', manifest.entry.slice('/_kay/'.length))
      const entry = await Bun.file(entryFile).text()

      expect(code).toBe(0)
      expect(report).toStartWith('built 10 islands, 0 stylesheets and 0 prerendered pages in ')
      expect(Object.keys(manifest.islands).sort()).toEqual(['counter.kay', 'greeting.kay', 'joined.kay', 'picker.kay', 'plain.kay', 'priced.kay', 'rich.kay', 'slow.kay', 'tally.kay', 'typed.kay'])
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
      'src/routes/index.kay': '--- server\nexport const page = { prerender: true }\n---\np Home\n',
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

      await Bun.write(join(root, 'src/routes/mail.kay'), '--- server\nimport { env } from \'../env\'\n\nexport const page = { prerender: true }\n\nconst to = env.MAIL_TO\n---\np {to}\n')
      const refused = await build()

      expect(refused.report).toContain('kay: MAIL_TO does not match the environment\'s schema')
      expect(refused.code).toBe(1)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})

describe('kay build checks the project first', () => {
  const build = async (root: string, ...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
    const [report, code] = await printed(child)

    return { report, code }
  }

  it('lints the heads of the pages it prerenders on a public site, failing on a lint the config denies', async () => {
    const config = (lints: string) => `export default { site: 'https://example.com', favicon: false, seo: { image: '/og.png' }, lints: ${lints} }\n`
    const root = await scratchProject({
      'tsconfig.json': tsconfig,
      'kay.config.ts': config('{ \'missing-description\': \'allow\', \'unsized-share-image\': \'allow\' }'),
      'src/routes/index.kay': '--- server\nexport const page = { prerender: true }\n---\nhead\n  title Home\n  meta(name="robots" content="noindex")\np Home\n',
      'src/routes/about.kay': '--- server\nexport const page = { prerender: true }\n---\nhead\n  title Home\n  meta(name="description" content="Who we are")\np About\n',
    })

    try {
      const warned = await build(root)

      expect(warned.report.match(/^\w+\[[\w-]+\]: .*/gm)).toEqual([
        'warning[duplicate-title]: `/` has the title of `/about`, "Home"',
        'warning[undescribed-page]: `/` has no description',
        'warning[noindex-in-sitemap]: `/` is in the sitemap, though its head says `noindex`',
      ])
      expect(warned.code).toBe(0)
      expect((await build(root, '--no-check')).report).not.toContain('warning[')

      await Bun.write(join(root, 'kay.config.ts'), config('{ seo: \'allow\', \'duplicate-title\': \'deny\' }'))
      const refused = await build(root)

      expect(refused.report.match(/^\w+\[[\w-]+\]/gm)).toEqual(['error[duplicate-title]'])
      expect(refused.report).toContain('kay build: nothing built, as the prerendered pages break the lints above; --no-check builds anyway')
      expect(refused.code).toBe(1)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('prints what the check found before what the prerendered pages log, and though their code ends the process', async () => {
    const root = await scratchProject({
      'tsconfig.json': tsconfig,
      'src/routes/index.kay': '--- server\nimport process from \'node:process\'\n\nexport const page = { prerender: true }\nconsole.error(\'prerendering\')\nprocess.exit(3)\n---\nh1 Home\nh3 Skipped\n',
    })

    try {
      const { report, code } = await build(root)

      expect(code).toBe(3)
      expect(report).toContain('warning[skipped-heading]')
      expect(report.indexOf('warning[skipped-heading]')).toBeLessThan(report.indexOf('prerendering'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('builds nothing from a project kay check refuses, and builds it with --no-check', async () => {
    const root = await scratchProject({ 'tsconfig.json': tsconfig, 'src/routes/index.kay': 'a(href="/nowhere") Lost\n' })

    try {
      const refused = await build(root)

      expect(refused.report).toContain('/nowhere')
      expect(refused.report).toContain('kay build: nothing built, as kay check found the problems above; --no-check builds anyway')
      expect(refused.code).toBe(1)
      expect(await Bun.file(join(outputDir(root), 'manifest.json')).exists()).toBe(false)

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
    const page = async (text: string, code = '') => Bun.write(join(root, 'src/routes/index.kay'), `--- server\nexport const page = { prerender: true }\nawait Bun.write(${JSON.stringify(ran)}, '${text}')\n${code}---\np ${text}\n`)
    const prerendered = join(outputDir(root), 'pages/index.html')
    const output = outputDir(root)
    const previous = `${outputDir(root)}-previous`

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

  it('answers what each stage of the build found and made, called without the command line', async () => {
    const root = await scratchProject({ 'tsconfig.json': tsconfig, 'src/routes/index.kay': '--- server\nexport const page = { prerender: true }\n---\na(href="/nowhere") Lost\n' })
    // In a process of its own, as the prerender registers the .kay loader for the project.
    const buildProject = async (options: BuildOptions = {}) => {
      const script = `import { buildProject } from ${JSON.stringify(join(import.meta.dir, '../src/build/pipeline'))}\n\nconst { built, ...result } = await buildProject(${JSON.stringify(root)}, {}, ${JSON.stringify(options)})\n\nconsole.log(JSON.stringify({ ...result, built: built && { ...built, report: undefined } }))\n`
      const child = Bun.spawn([process.execPath, '-e', script], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

      expect({ code, errors }).toEqual({ code: 0, errors: '' })

      return JSON.parse(output.trim().split('\n').at(-1)!) as BuildResult
    }

    try {
      const refused = await buildProject()

      expect(refused.failed).toEqual({ stage: 'check' })
      expect(refused.checked.map(diagnostic => diagnostic.message)).toEqual([expect.stringContaining('/nowhere')])
      expect(refused.built).toBeUndefined()
      expect(existsSync(outputDir(root))).toBe(false)

      await Bun.write(join(root, 'src/routes/index.kay'), '--- server\nexport const page = { prerender: true }\n---\na(href="/") Home\n')

      const built = await buildProject({ exportTo: 'dist' })

      // The heads' lints only warn, which fails no stage.
      expect(built).toMatchObject({ checked: [], linted: [{ code: 'untitled-page', severity: 'warning' }, { code: 'undescribed-page', severity: 'warning' }], built: { islands: 0, stylesheets: 0, prerendered: 1, entries: 0 }, exported: { pages: 1, dir: join(root, 'dist') } })
      expect(built.failed).toBeUndefined()
      expect(await Bun.file(join(root, 'dist/index.html')).text()).toContain('>Home</a>')
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

describe('the runtime chunk', () => {
  it('anchors the same module whatever order Bun reports the runtime\'s imports in, so its chunk keeps its name across development builds', () => {
    const one = new Map([['kay/client', new Set(['hydrateIslands', 'enableHotSwap'])], ['kay', new Set(['signal', 'refresh'])], ['kay/navigate', new Set(['*'])]])
    const other = new Map([['kay/navigate', new Set(['*'])], ['kay', new Set(['refresh', 'signal'])], ['kay/client', new Set(['enableHotSwap', 'hydrateIslands'])]])

    expect(anchorModule(other)).toBe(anchorModule(one))
    expect(anchorModule(one)).toContain('import { refresh as k0, signal as k1 } from "kay"')
  })
})

describe('the files a build writes', () => {
  it('keeps each worker of bun test --parallel to its own output and class list, and the paths an app names otherwise', () => {
    const worker = process.env.BUN_TEST_WORKER_ID

    try {
      process.env.BUN_TEST_WORKER_ID = '3'
      expect([outputDir('/app'), projectPaths('/app').classes]).toEqual(['/app/.kay/client-3', '/app/.kay/classes-3.txt'])
      delete process.env.BUN_TEST_WORKER_ID
      expect([outputDir('/app'), projectPaths('/app').classes]).toEqual(['/app/.kay/client', '/app/.kay/classes.txt'])
    }
    finally {
      if (worker === undefined)
        delete process.env.BUN_TEST_WORKER_ID
      else
        process.env.BUN_TEST_WORKER_ID = worker
    }
  })

  it('leaves a file whose text is the same alone, moves a changed one into place whole, and leaves no draft behind a write that failed', async () => {
    const dir = await scratchDir('write-')
    const file = join(dir, 'deep/classes.txt')

    try {
      await writeIfChanged(file, 'a')

      const written = (await stat(file)).mtimeMs

      await Bun.sleep(10)
      await writeIfChanged(file, 'a')
      expect((await stat(file)).mtimeMs).toBe(written)
      await writeIfChanged(file, 'b')
      expect(await Bun.file(file).text()).toBe('b')
      expect(await readdir(join(dir, 'deep'))).toEqual(['classes.txt'])

      // A directory where the file goes, which no rename replaces.
      await mkdir(join(dir, 'taken'))
      await expect(writeIfChanged(join(dir, 'taken'), 'c')).rejects.toThrow()
      expect((await readdir(dir)).sort()).toEqual(['deep', 'taken'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('says an error\'s message when its stack starts with the name alone', () => {
    const error = new Error('database is locked')

    error.stack = 'Error\n    at claim (/app/src/jobs.ts:3:9)'
    expect(describeThrown(error)).toBe('Error: database is locked\n    at claim (/app/src/jobs.ts:3:9)')
    const bare = new Error('kept')

    bare.message = ''
    bare.stack = 'Error\n    at x (/a.ts:1:1)'
    expect(describeThrown(bare)).toBe('Error\n    at x (/a.ts:1:1)')
  })
})

describe('a stylesheet imported as text', () => {
  it('reads the file under Bun, in the executable and in an island, types as a string in kay check, and stays out of the page\'s stylesheets', async () => {
    const root = await scratchProject({
      'tsconfig.json': tsconfig,
      'kay.config.ts': 'export default { favicon: false }\n',
      'src/theme.css': ':root { --brand: #123456 }\n.themed { color: red }\n',
      'src/app.css': '.app { color: blue }\n',
      'src/later.css': '.later { color: green }\n',
      'src/badge.css': '.badge-text { color: gold }\n',
      'src/badge.kay': '---\nimport { signal } from \'kay\'\nimport badge from \'./badge.css\' with { type: \'text\' }\n\nconst on = signal(false)\n---\nbutton(onClick={() => on.set(o => !o)}) {on() ? badge : badge.length}\n',
      'src/routes/index.kay': '---\nimport \'../app.css\'\nimport Badge from \'../badge.kay\'\n---\n--- server\nimport theme from \'../theme.css\' with { type: \'text\' }\n\nconst size: number = theme.length\n---\np.size {size}\nBadge\n',
      'src/server.ts': 'import process from \'node:process\'\nimport { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\nimport theme from \'./theme.css\' with { type: \'text\' }\n\nconst { default: later } = await import(\'./later.css\', { with: { type: \'text\' } })\nconst app = new Elysia().use(await pages({ security: false }))\nconst page = await (await app.handle(new Request(\'http://localhost/\'))).text()\n\nconsole.log(JSON.stringify({ theme, later, page: /<p class="size">(\\d+)<\\/p>/.exec(page)?.[1] }))\nprocess.exit(0)\n',
    })
    const theme = await Bun.file(join(root, 'src/theme.css')).text()
    const read = async (command: string[]) => {
      const child = Bun.spawn(command, { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, stdout: 'pipe', stderr: 'pipe' })
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

      expect({ code, errors }).toEqual({ code: 0, errors: expect.any(String) })

      return JSON.parse(output.trim().split('\n').at(-1)!) as { theme: string, later: string, page: string }
    }

    try {
      const built = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, '--compile', join(root, 'server')], { stdout: 'pipe', stderr: 'pipe' })
      const [report, code] = await printed(built)

      expect(report).not.toContain('error')
      expect(code).toBe(0)
      const expected = { theme, later: '.later { color: green }\n', page: String(theme.length) }

      expect(await read([join(root, 'server')])).toEqual(expected)
      expect(await read([process.execPath, 'src/server.ts'])).toEqual(expected)
      // A stylesheet imported for its effect leaves no text behind in the code.
      expect((await Bun.file(join(root, 'server')).text()).includes('.app { color')).toBe(false)

      const files = await readdir(clientDir(root), { recursive: true })
      const joined = async (extension: string) => (await Promise.all(files.filter(name => name.endsWith(extension)).map(async name => Bun.file(join(clientDir(root), name)).text()))).join('')
      const [styles, scripts] = await Promise.all([joined('.css'), joined('.js')])

      expect(styles).toContain('.app')
      expect(styles).not.toContain('themed')
      expect(styles).not.toContain('badge-text')
      expect(scripts).toContain('.badge-text { color: gold }')
      expect(scripts).not.toContain('.app { color')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('a compiled server with layouts', () => {
  it('boots with its sources gone, each layout\'s actions behind the guards of its own directory, a library\'s too', async () => {
    const action = (name: string, settings = '') => `--- server\nimport { t } from 'elysia'\nimport { action } from 'kay'\n\n${settings}export const ${name} = action(t.Object({}), () => '${name}')\n---\nslot\n`
    const root = await scratchProject({
      'tsconfig.json': tsconfig,
      'kay.config.ts': 'export default { favicon: false, requireGuards: true, extensions: [{ name: \'lib\', routes: { dir: \'lib/routes\', prefix: \'/lib\' } }] }\n',
      'lib/routes/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'x-lib\'))\n    deny(403)\n})\n',
      'lib/routes/_layout.kay': action('track'),
      'lib/routes/index.kay': 'h1 Library\n',
      'src/routes/_layout.kay': action('leave', 'export const page = { guards: false }\n'),
      'src/routes/index.kay': '--- server\nexport const page = { guards: false }\n---\nh1 Home\n',
      'src/routes/staff/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'x-admin\'))\n    deny(403, \'Admins only\')\n})\n',
      'src/routes/staff/_layout.kay': action('promote'),
      'src/routes/staff/sign-in.kay': '--- server\nexport const page = { guards: false }\n---\nh1 Staff\n',
      'src/server.ts': `import process from 'node:process'
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

const app = new Elysia().use(await pages({ security: false }))
const post = async (file: string, name: string, headers: Record<string, string> = {}) => (await app.handle(new Request(\`http://localhost/_kay/action/src/routes/\${file}/\${name}\`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'referer': 'http://localhost/', ...headers }, body: '[{}]' }))).status

console.log(JSON.stringify({ home: (await app.handle(new Request('http://localhost/'))).status, leave: await post('_layout.kay', 'leave'), promote: await post('staff/_layout.kay', 'promote'), admin: await post('staff/_layout.kay', 'promote', { 'x-admin': '1' }), track: await post('../../lib/routes/_layout.kay', 'track'), tracked: await post('../../lib/routes/_layout.kay', 'track', { 'x-lib': '1' }) }))
process.exit(0)
`,
    })

    try {
      const [report, code] = await printed(Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, '--compile', join(root, 'server')], { stdout: 'pipe', stderr: 'pipe' }))

      expect(report).not.toContain('error')
      expect(code).toBe(0)
      // The executable reads nothing from the sources, the layouts' settings included.
      await rename(join(root, 'src'), join(root, 'moved'))
      await rename(join(root, 'lib'), join(root, 'moved-lib'))
      const child = Bun.spawn([join(root, 'server')], { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, stdout: 'pipe', stderr: 'pipe' })
      const [output, errors, exited] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

      expect({ exited, errors }).toEqual({ exited: 0, errors: expect.any(String) })
      expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({ home: 200, leave: 200, promote: 403, admin: 200, track: 403, tracked: 200 })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
