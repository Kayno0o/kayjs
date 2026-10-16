import type { BunPlugin } from 'bun'
import type { BuildOptions, BuildResult } from '../src/build/pipeline'
import type { BuildSummary, RouteSize, SizeReport, StoredReport } from '../src/build/report'
import type { RenderedPage } from '../src/check/seo'
import type { KayConfig } from '../src/config'
import type { ClientBuild } from '../src/server/client'
import type { Route } from '../src/server/routes'
import { existsSync, utimesSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rename, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { ASSET_FILE, clientDir, outputDir, writeAsset } from '../src/build/assets'
import { writeCacheEntry } from '../src/build/cache'
import { buildClient, readClientSources } from '../src/build/client'
import { forgetSources, keepSources, readSource, realPath, writeAtomically, writeIfChanged } from '../src/build/files'
import { fileWords, reachesAny } from '../src/build/libraries'
import { BUNDLED_LICENCES, codecWarnings, thirdPartyNotices, unknownCodecVersions } from '../src/build/licenses'
import { formatBuildReport, formatRemoved, formatRouteTable, formatSizeReport, gzipSize, shorten, writeStoredReport } from '../src/build/report'
import { routeSizes } from '../src/build/route-sizes'
import { anchorModule, runtimeChunk } from '../src/build/runtime-chunk'
import { runtimeConfig, withoutPlugins } from '../src/build/runtime-config'
import { importedSignals, inSignalsScope } from '../src/build/signals'
import { describeThrown, mapBundleToKay, mapStack } from '../src/build/sourcemap'
import { analyzeKayCached, compilerModules, keepAnalyses, pruneCompileCache, transformKayCached } from '../src/build/transform'
import { loadConfig, withConfig } from '../src/config'
import { devBuilder } from '../src/dev/builder'
import { projectPaths } from '../src/project'
import { serveBuildFiles } from '../src/server/build-files'
import { compileErrorPage } from '../src/server/overlay'
import { encodePng } from '../src/server/png'
import { fixtureCopy, scratchDir } from './scratch'

const root = join(import.meta.dir, 'fixtures/islands')

// Under the checkout's node_modules, so the pages it serves resolve their dependencies.
async function scratchProject(files: Record<string, string>): Promise<string> {
  const base = join(import.meta.dir, '../node_modules/.cache')

  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'config-'))

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

// Ages a file's times, as a file written a while ago has them, so the caches trusting a stamp do trust it.
function settle(...files: string[]): void {
  const past = new Date(Date.now() - 60_000)

  for (const file of files)
    utimesSync(file, past, past)
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

  it('gives a static component that may render as an island a chunk once it reaches one, directly, through a barrel, a library or a glob, under a linked root too', async () => {
    const passing = (imports: string) => `---\n${imports}\nimport { go } from '../go'\n---\nIsl(format={go})\n`
    const root = await scratchProject({
      'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { 'ui-lib': '1.0.0' } }),
      'node_modules/ui-lib/package.json': JSON.stringify({ name: 'ui-lib', version: '1.0.0', type: 'module', peerDependencies: { kay: '*' }, exports: { './*.kay': './src/*.kay' } }),
      'node_modules/ui-lib/src/card.kay': '---\nimport { signal } from \'kay\'\n\nconst { format } = props<{ format: (n: number) => string }>()\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {format(n())}\n',
      'src/cards/isl.kay': '---\nimport { signal } from \'kay\'\n\nconst { format } = props<{ format: (n: number) => string }>()\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {format(n())}\n',
      'src/go.ts': 'export function go(n: number): string {\n  return String(n)\n}\n',
      'src/ui/barrel.ts': 'export { default as Isl } from \'../cards/isl.kay\'\n',
      'src/ui/direct.kay': passing('import Isl from \'../cards/isl.kay\''),
      'src/ui/barreled.kay': passing('import { Isl } from \'./barrel\''),
      'src/ui/library.kay': passing('import Isl from \'ui-lib/card.kay\''),
      'src/ui/glob.kay': passing('const { \'../cards/isl.kay\': Isl } = import.meta.glob(\'../cards/*.kay\', { eager: true, import: \'default\' })'),
      // Reaching no island, it never renders as one.
      'src/ui/label.kay': '---\nconst { text } = props<{ text: string }>()\n---\nspan {text}\n',
      'src/ui/plain.kay': '---\nimport { go } from \'../go\'\nimport Label from \'./label.kay\'\n---\nLabel(text={go(1)})\n',
    })
    const linked = `${root}-linked`

    await symlink(root, linked)

    try {
      const islands = ['node_modules/ui-lib/src/card.kay', 'src/cards/isl.kay', 'src/ui/barreled.kay', 'src/ui/direct.kay', 'src/ui/glob.kay', 'src/ui/library.kay']

      expect(Object.keys((await buildClient(root)).islands).sort()).toEqual(islands)
      // Bun resolves imports to real paths, which a project's own modules are found under too.
      expect(Object.keys((await buildClient(linked)).islands).sort()).toEqual(islands)
    }
    finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(linked, { force: true })])
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

  it('builds the stylesheets again in kay dev only for a word Tailwind makes a class of', async () => {
    const project = resolve(await fixtureCopy('tailwind'))
    const page = join(project, 'src/routes/index.kay')
    const source = await Bun.file(page).text()
    const build = devBuilder(project, { plugins: [tailwind] })
    const rebuilds = async (added: string) => {
      // A build reads its stylesheets' sources once done, which the next one waits for: an empty one, so the edit comes after.
      await build([])
      await Bun.write(page, `${source}  p ${added}\n`)

      return (await build(['src/routes/index.kay'])).styles !== undefined
    }

    try {
      expect((await build(null)).styles).toBeDefined()
      expect(await rebuilds('Bonjour tout le monde')).toBe(false)
      expect(await rebuilds('Bonjour underline-offset-4')).toBe(true)
      expect(await rebuilds('Bonjour underline-offset-4 encore')).toBe(false)
      // A value Tailwind reads across what splits words, a dotted shorthand and an arbitrary one.
      expect(await rebuilds('Bonjour underline-offset-4 encore span(class="bg-(--brand)")')).toBe(true)
      expect(await rebuilds('Bonjour underline-offset-4 encore span.py-1')).toBe(true)
      expect(await rebuilds('Bonjour underline-offset-4 encore span.py-1 span.py-1.5')).toBe(true)
      expect(await rebuilds('Bonjour underline-offset-4 encore span.py-1 span.py-1.5 span(class="w-[13px]")')).toBe(true)
    }
    finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it('builds the stylesheets again in kay dev for an edit of the imports of a module they follow, whatever other modules the earlier builds signed', async () => {
    const project = await scratchDir('kay-sheets-')
    const files = {
      'src/parts/card.css': '.card { color: red }\n',
      'src/parts/extra.css': '.extra { color: blue }\n',
      'src/parts/card.kay': '---\nimport \'./card.css\'\n---\narticle.card x\n',
      'src/routes/index.kay': '---\nimport Card from \'../parts/card.kay\'\n---\nCard\n',
    }

    await Promise.all(Object.entries(files).map(async ([file, content]) => Bun.write(join(project, file), content)))
    const build = devBuilder(project, {})
    const cwd = process.cwd()
    const card = join(project, 'src/parts/card.kay')
    const sheet = async (styles: Record<string, string>) => (Bun.file(join(clientDir(project), styles['src/routes/index.kay']!.slice('/_kay/'.length))).text())
    // A build reads its stylesheets' inputs once done, which the next one waits for: an empty one, so the edit comes after.
    const edit = async (source: string, file = card, name = 'src/parts/card.kay') => {
      await build([])
      await Bun.write(file, source)

      return build([name])
    }

    try {
      // As `kay dev` starts its builder, with the root as the working directory.
      process.chdir(project)
      const first = await build(null)

      expect(await sheet(first.styles!)).not.toContain('.extra')
      // The text alone: the imports it signs as are the same.
      expect((await edit('---\nimport \'./card.css\'\n---\narticle.card y\n')).styles).toBeUndefined()
      expect((await edit('---\nimport \'./card.css\'\n---\nsection\n  article.card y\n')).styles).toBeUndefined()

      const added = await edit('---\nimport \'./card.css\'\nimport \'./extra.css\'\n---\narticle.card y\n')

      expect(await sheet(added.styles!)).toContain('.extra')
      // The page, signed by the build above, is unchanged in what it imports; the card's new signature is the one kept.
      expect((await edit('---\nimport Card from \'../parts/card.kay\'\n---\nCard\np page\n', join(project, 'src/routes/index.kay'), 'src/routes/index.kay')).styles).toBeUndefined()
      expect((await edit('---\nimport \'./card.css\'\nimport \'./extra.css\'\n---\narticle.card z\n')).styles).toBeUndefined()

      const removed = await edit('---\nimport \'./card.css\'\n---\narticle.card z\n')

      expect(await sheet(removed.styles!)).not.toContain('.extra')
      // A module that stops parsing has no signature: it builds them again, and again once fixed.
      expect((await edit('---\nimport \'./card.css\'\n---\narticle.card z {\n')).failed).toBe(true)
      expect((await edit('---\nimport \'./card.css\'\nimport \'./extra.css\'\n---\narticle.card z\n')).styles).toBeDefined()
    }
    finally {
      process.chdir(cwd)
      await rm(project, { recursive: true, force: true })
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
      // `button(onClick={() => count.set(count() + 1)}) Count {count()}` is the template's one line.
      expect(lines).toContain(source.split('\n').findIndex(line => line.startsWith('button(')))
      expect(Math.max(...lines)).toBeLessThan(source.split('\n').length)
    }
    finally {
      await rm(join(root, '.kay'), { recursive: true, force: true })
    }
  })

  it('keys each page\'s stylesheet by its own file, from a working directory other than the root', async () => {
    // A library holding its own routes and an app testing it inside: from the library, its layout and the app's share a relative path.
    const base = await scratchProject({
      'src/routes/_layout.kay': '---\nimport \'./admin.css\'\n---\nsection\n  slot\n',
      'src/routes/admin.css': '.admin { color: teal }\n',
      'fixture/src/app.css': '.app { color: red }\n',
      'fixture/src/routes/_layout.kay': '---\nimport \'../app.css\'\n---\nmain\n  slot\n',
      'fixture/src/routes/index.kay': 'p home\n',
    })
    const app = join(base, 'fixture')
    const cwd = process.cwd()

    try {
      process.chdir(base)
      const { styles } = await buildClient(app, { extensions: [{ name: 'lib', routes: { dir: join(base, 'src/routes'), prefix: '/admin' } }] })
      const sheet = async (file: string) => Bun.file(join(clientDir(app), basename(styles.get(file)!))).text()

      expect(await sheet(join(app, 'src/routes/_layout.kay'))).toContain('.app')
      expect(await sheet(join(base, 'src/routes/_layout.kay'))).toContain('.admin')
    }
    finally {
      process.chdir(cwd)
      await rm(base, { recursive: true, force: true })
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

  it('keeps every color-mix() of a rule through Tailwind and in plain CSS, built for production and in kay dev, where Bun alone keeps the first', async () => {
    const project = await scratchDir('supports-')
    const mixes = ':root {\n  --tint: color-mix(in srgb, var(--accent) 14%, var(--base));\n  --line: color-mix(in srgb, var(--text) 12%, transparent);\n}\n'
    const files = {
      'src/app.css': `@import 'tailwindcss';\n${mixes}`,
      'src/plain.css': '.plain {\n  --x: 1;\n  @supports (display: grid) {\n    --x: 2;\n  }\n  --y: 1;\n  @supports (display: grid) {\n    --y: 2;\n  }\n}\n',
      'src/routes/index.kay': '---\nimport \'../app.css\'\nimport \'../plain.css\'\n---\np Hello\n',
    }

    await Promise.all(Object.entries(files).map(async ([file, content]) => Bun.write(join(project, file), content)))

    const stylesheet = async (url: string) => (await Bun.file(join(clientDir(project), url.slice('/_kay/'.length))).text()).replace(/\s/g, '')
    const expectAll = (css: string) => {
      expect(css).toContain('--tint:color-mix(insrgb,var(--accent)14%,var(--base))')
      expect(css).toContain('--line:color-mix(insrgb,var(--text)12%,transparent)')
      expect(css).toContain('--x:2')
      expect(css).toContain('--y:2')
    }

    try {
      expectAll(await stylesheet((await buildClient(project, { plugins: [tailwind], minify: true })).styles.get(join(project, 'src/routes/index.kay'))!))
      expectAll(await stylesheet((await devBuilder(project, { plugins: [tailwind] })(null)).styles!['src/routes/index.kay']!))
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
      expect(report).toStartWith('built 12 islands, 0 stylesheets and 0 prerendered pages in ')
      expect(Object.keys(manifest.islands).sort()).toEqual(['counter.kay', 'greeting.kay', 'joined.kay', 'mounted.kay', 'picker.kay', 'plain.kay', 'priced.kay', 'rich.kay', 'slow.kay', 'tally.kay', 'typed.kay', 'vouched.kay'])
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

  it('builds a project through a link to it as from its real path, its islands and a library\'s named and bundled alike', async () => {
    const counter = '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {n()}\n'
    const root = await scratchProject({
      'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { 'ui-lib': '1.0.0' } }),
      'node_modules/ui-lib/package.json': JSON.stringify({ name: 'ui-lib', version: '1.0.0', type: 'module', peerDependencies: { kay: '*' }, exports: { './*.kay': './src/*.kay' } }),
      'node_modules/ui-lib/src/card.kay': counter,
      'src/counter.kay': counter,
      'src/routes/index.kay': '--- server\nexport const page = { prerender: true }\n---\n---\nimport Card from \'ui-lib/card.kay\'\nimport Counter from \'../counter.kay\'\n---\nCounter\nCard\n',
    })
    const link = `${root}-link`

    await symlink(root, link)

    try {
      const [report, code] = await printed(Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', link, '--no-check', '--static'], { stdout: 'pipe', stderr: 'pipe' }))
      const html = await Bun.file(join(root, 'dist/index.html')).text()
      const manifest = await Bun.file(join(outputDir(root), 'manifest.json')).json() as { islands: Record<string, string[]> }

      expect(code, report).toBe(0)
      expect([...html.matchAll(/data-component="([^"]+)"/g)].map(match => match[1])).toEqual(['src/counter.kay', 'node_modules/ui-lib/src/card.kay'])
      expect(Object.keys(manifest.islands).sort()).toEqual(['node_modules/ui-lib/src/card.kay', 'src/counter.kay'])
    }
    finally {
      await rm(link, { force: true })
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

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

  describe('--format json and github', () => {
    const documented = async (root: string, ...args: string[]) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

      expect(stdout.trimEnd().split('\n'), stderr).toHaveLength(1)

      return { document: JSON.parse(stdout) as { errors: number, warnings: number, failed?: { stage: string }, built?: unknown, problems: { file?: string, severity: string, code: string | null, message: string }[] }, stdout, stderr, code }
    }

    it('gives what the check found in its shape, and the check as the stage that stopped the build', async () => {
      const root = await scratchProject({
        'tsconfig.json': tsconfig,
        'kay.config.ts': 'export default { favicon: false }\n',
        'src/routes/index.kay': '--- server\nconst n: number = \'one\'\n---\np {n}\n',
      })

      try {
        const { document, code } = await documented(root, '--format', 'json')

        expect(code).toBe(1)
        expect(document.failed).toEqual({ stage: 'check' })
        expect(document.built).toBeUndefined()
        expect(document.errors).toBeGreaterThan(0)
        expect(document.problems[0]).toMatchObject({ file: relative(process.cwd(), join(root, 'src/routes/index.kay')), severity: 'error' })
      }
      finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 60_000)

    it('gives the lints of the prerendered pages, the output as the stage they stopped', async () => {
      const root = await scratchProject({
        'tsconfig.json': tsconfig,
        'kay.config.ts': 'export default { site: \'https://example.com\', favicon: false, seo: { image: \'/og.png\' }, lints: { seo: \'allow\', \'duplicate-title\': \'deny\' } }\n',
        'src/routes/index.kay': '--- server\nexport const page = { prerender: true }\n---\nhead\n  title Home\n  meta(name="description" content="Home")\np Home\n',
        'src/routes/about.kay': '--- server\nexport const page = { prerender: true }\n---\nhead\n  title Home\n  meta(name="description" content="Who we are")\np About\n',
      })

      try {
        const { document, code } = await documented(root, '--format', 'json')

        expect(code).toBe(1)
        expect(document.failed).toEqual({ stage: 'output' })
        expect(document.problems.map(problem => problem.code)).toEqual(['duplicate-title'])
      }
      finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 60_000)

    it('gives the problems found so far once a prerendered page ends the process', async () => {
      const root = await scratchProject({
        'tsconfig.json': tsconfig,
        'src/routes/index.kay': '--- server\nimport process from \'node:process\'\n\nexport const page = { prerender: true }\nconsole.log(\'prerendering\')\nprocess.exit(3)\n---\nh1 Home\nh3 Skipped\n',
      })

      try {
        const { document, stderr, code } = await documented(root, '--format', 'json')

        expect(code).toBe(3)
        expect(stderr).toContain('prerendering')
        expect(document.failed).toEqual({ stage: 'output' })
        expect(document.problems.map(problem => problem.code ?? problem.message)).toEqual(['skipped-heading', 'the build ended with exit code 3 before it was done'])
        expect([document.errors, document.warnings]).toEqual([1, 1])
      }
      finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 60_000)

    it('names the bundle as the stage a browser build plugin ended the process in under --no-check, failing an exit code 0', async () => {
      const root = await scratchProject({
        'tsconfig.json': tsconfig,
        'kay.config.ts': 'import process from \'node:process\'\n\nexport default { favicon: false, plugins: [{ name: \'quit\', setup() { process.exit(0) } }] }\n',
        'src/routes/index.kay': 'h1 Home\n',
      })

      try {
        const { document, code } = await documented(root, '--no-check', '--format', 'json')

        expect(code).toBe(1)
        expect(document.failed).toEqual({ stage: 'bundle' })
        expect(document.problems.map(problem => problem.message)).toEqual(['the build ended with exit code 0 before it was done'])
      }
      finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 60_000)

    it('answers options that do not go together with an error document', async () => {
      const { document, stderr, code } = await documented('.', '--no-check', '-p', 'tsconfig.json', '--format', 'json')

      expect(code).toBe(1)
      expect(stderr).toBe('kay build: -p names the tsconfig the build checks with, so it does not go with --no-check\n')
      expect(document).toEqual({ errors: 1, warnings: 0, problems: [{ severity: 'error', code: 'command-usage', message: '-p names the tsconfig the build checks with, so it does not go with --no-check' }] })
    })

    it('annotates a template that does not compile under --format github, at its place', async () => {
      const root = await scratchProject({
        'kay.config.ts': 'export default { favicon: false }\n',
        'src/routes/index.kay': 'p Home\neach x in y\n  p {x}\n',
      })

      try {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, '--no-check', '--format', 'github'], { stdout: 'pipe', stderr: 'pipe' })
        const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

        expect(code).toBe(1)
        expect(stdout).toBe(`::error file=${relative(process.cwd(), join(root, 'src/routes/index.kay'))},line=2,col=1,endLine=2,endColumn=5,title=template-syntax::\`each\` is pug syntax kay does not have%0Ahelp: kay loops with \`for item of list\`\n`)
      }
      finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 30_000)
  })

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

      // A plain build drops the record of an executable an earlier build compiled, so `kay start` runs the entry of this one.
      const record = join(outputDir(root), 'executable')

      await Bun.write(record, 'bin/server')
      expect(await buildProject({ check: false })).toMatchObject({ built: { prerendered: 1 } })
      expect(existsSync(record)).toBe(false)

      // A callback that throws once the output is written puts the last build back.
      await Bun.write(join(root, 'src/routes/index.kay'), '--- server\nexport const page = { prerender: true }\n---\na(href="/") Away\n')
      const script = `import { buildProject } from ${JSON.stringify(join(import.meta.dir, '../src/build/pipeline'))}\n\ntry {\n  await buildProject(${JSON.stringify(root)}, {}, { onStage: (stage) => { if (stage === 'output') throw new Error('printer down') } })\n}\ncatch (error) {\n  console.log(error.message)\n}\n`
      const child = Bun.spawn([process.execPath, '-e', script], { cwd: root, stdout: 'pipe', stderr: 'pipe' })

      expect(await new Response(child.stdout).text()).toBe('printer down\n')
      expect(await Bun.file(join(outputDir(root), 'pages/index.html')).text()).toContain('>Home</a>')
      expect(existsSync(`${outputDir(root)}-previous`)).toBe(false)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('warns once of an SVG favicon\'s text, as the check when it runs, as the drawing when it does not', async () => {
    const root = await scratchProject({
      'tsconfig.json': tsconfig,
      'src/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text x="4" y="24">K</text></svg>',
      'src/routes/index.kay': 'p Home\n',
    })
    // The warnings the build answers with and the ones it logs, in a process of its own as the prerender registers the .kay loader.
    const warnings = async (options: BuildOptions) => {
      const script = `import { buildProject } from ${JSON.stringify(join(import.meta.dir, '../src/build/pipeline'))}\n\nconst { checked } = await buildProject(${JSON.stringify(root)}, { favicon: 'src/favicon.svg' }, ${JSON.stringify(options)})\n\nconsole.log(JSON.stringify(checked.map(diagnostic => diagnostic.message)))\n`
      const child = Bun.spawn([process.execPath, '-e', script], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

      expect(code).toBe(0)

      return [...JSON.parse(output.trim().split('\n').at(-1)!) as string[], ...errors.split('\n')].filter(line => line.includes('has text, which kay draws without fonts'))
    }

    try {
      expect(await warnings({})).toHaveLength(1)
      expect(await warnings({ check: false })).toHaveLength(1)
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
  it('keys every entry on the kay modules the compiler imports, outside its own directory too', () => {
    const src = join(import.meta.dir, '../src')
    const modules = compilerModules(join(src, 'compiler')).map(file => relative(src, file))

    expect(modules).toContain('compiler/parser.ts')
    expect(modules).toEqual(expect.arrayContaining(['runtime/markers.ts', 'runtime/base.ts', 'runtime/root.ts', 'runtime/form.ts', 'runtime/action.ts']))
    expect(modules.filter(file => file.startsWith('server/'))).toEqual([])
  })

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

describe('what a build keeps in memory', () => {
  it('keeps a component\'s analysis while its inputs stay, the signals of the modules it imports included', async () => {
    const dir = await scratchDir('kay-analysis-')
    const cacheDir = join(dir, 'cache')
    const file = join(dir, 'count.kay')
    const source = '---\nimport { count } from \'./state\'\n---\np.count {count()}\n'

    try {
      await Bun.write(join(dir, 'state.ts'), 'import { signal } from \'kay\'\n\nexport const count = signal(0)\n')
      const analysis = await analyzeKayCached(source, file, dir, cacheDir)

      // Read from memory, not from the cache entry gone meanwhile, which a compile would write again.
      await rm(cacheDir, { recursive: true })
      expect(await analyzeKayCached(source, file, dir, cacheDir)).toBe(analysis)
      expect(existsSync(cacheDir)).toBe(false)

      await Bun.write(join(dir, 'state.ts'), 'export const count = () => 0\n')
      const changed = await analyzeKayCached(source, file, dir, cacheDir)

      expect(changed).not.toBe(analysis)
      expect(await readdir(cacheDir)).toEqual([expect.stringMatching(/-analysis\.json$/)])

      // A file no longer built is forgotten, read from its cache entry again.
      keepAnalyses(new Set())
      expect(await analyzeKayCached(source, file, dir, cacheDir)).not.toBe(changed)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('looks up the signals a component imports once inside a scope, and from the disk again in the next', async () => {
    const dir = resolve(await scratchDir('kay-scope-'))
    const file = join(dir, 'count.kay')
    const source = '---\nimport { count } from \'./state\'\n---\np.count {count()}\n'
    const asSignal = 'import { signal } from \'kay\'\n\nexport const count = signal(0)\n'

    try {
      await Bun.write(join(dir, 'state.ts'), asSignal)
      // Outside a scope every call looks again.
      expect(importedSignals(file, source)).toEqual({ './state': { count: 'signal' } })
      await Bun.write(join(dir, 'state.ts'), 'export const count = () => 0\n')
      expect(importedSignals(file, source)).toEqual({})
      await Bun.write(join(dir, 'state.ts'), asSignal)

      await inSignalsScope(async () => {
        const first = importedSignals(file, source)

        expect(first).toEqual({ './state': { count: 'signal' } })
        await Bun.write(join(dir, 'state.ts'), 'export const count = () => 0\n')
        // The files do not change inside a build: the second pass over the component gets the first one's answer.
        expect(importedSignals(file, source)).toBe(first)
        // A changed source of the component itself is looked up again.
        expect(importedSignals(file, `${source}\n`)).toEqual({})
      })

      await inSignalsScope(async () => {
        expect(importedSignals(file, source)).toEqual({})
        await Bun.write(join(dir, 'state.ts'), asSignal)
      })
      await inSignalsScope(async () => {
        expect(importedSignals(file, source)).toEqual({ './state': { count: 'signal' } })
      })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the signals looked up in each of two scopes open at once to the calls inside it', async () => {
    const dir = resolve(await scratchDir('kay-scope-'))
    const file = join(dir, 'count.kay')
    const source = '---\nimport { count } from \'./state\'\n---\np.count {count()}\n'

    try {
      await Bun.write(join(dir, 'state.ts'), 'import { signal } from \'kay\'\n\nexport const count = signal(0)\n')
      const { promise: held, resolve: release } = Promise.withResolvers<void>()
      const early = inSignalsScope(async () => {
        const found = importedSignals(file, source)

        await held

        return found
      })

      // A scope opened while the first is open does not see what the first looked up.
      await Bun.write(join(dir, 'state.ts'), 'export const count = () => 0\n')
      expect(await inSignalsScope(async () => importedSignals(file, source))).toEqual({})
      release()
      expect(await early).toEqual({ './state': { count: 'signal' } })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('compiles an island again in kay dev once a module it imports stops exporting a signal', async () => {
    const project = await scratchProject({
      'src/state.ts': 'import { signal } from \'kay\'\n\nexport const total = signal(0)\n',
      'src/total.kay': '---\nimport { total } from \'./state\'\n---\nbutton(type="button" onClick={() => total.set(1)}) {total}\n',
      'src/routes/index.kay': '---\nimport Total from \'../total.kay\'\n---\nTotal\n',
    })
    const build = devBuilder(project, {})
    const island = async () => {
      const { islands } = await Bun.file(join(outputDir(project), 'manifest.json')).json() as { islands: Record<string, string[]> }

      return Bun.file(join(clientDir(project), basename(islands['src/total.kay']![0]!))).text()
    }

    try {
      expect((await build(null)).failed).toBe(false)
      // A signal the template names without calling is read as one.
      expect(await island()).toContain('() => total()')

      await Bun.write(join(project, 'src/state.ts'), 'export const total = 0\n')
      expect((await build(['src/state.ts'])).failed).toBe(false)
      expect(await island()).not.toContain('total()')

      await Bun.write(join(project, 'src/state.ts'), 'import { signal } from \'kay\'\n\nexport const total = signal(0)\n')
      expect((await build(['src/state.ts'])).failed).toBe(false)
      expect(await island()).toContain('() => total()')
    }
    finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it('reads a source file again once it was edited, replaced, retargeted or deleted, with nothing telling the cache', async () => {
    const dir = resolve(await scratchDir('kay-reads-'))
    const file = join(dir, 'a.ts')
    const link = join(dir, 'link.ts')

    try {
      await Bun.write(file, 'export const a = 1\n')
      await Bun.write(join(dir, 'b.ts'), 'export const b = 2\n')
      await symlink(file, link)
      settle(file, join(dir, 'b.ts'))
      const first = readSource(file)

      expect(readSource(file)).toBe(first)
      expect(fileWords(file)).toEqual(['export', 'const', 'a', '1'])
      expect(fileWords(file)).toBe(fileWords(file))

      // The same size, so only the times tell.
      await Bun.write(file, 'export const a = 2\n')
      settle(file)
      expect(readSource(file).text).toBe('export const a = 2\n')
      expect(fileWords(file)).toContain('2')

      expect(readSource(link).text).toBe('export const a = 2\n')
      await rm(link)
      await symlink(join(dir, 'b.ts'), link)
      expect(readSource(link).text).toBe('export const b = 2\n')

      await Bun.write(join(dir, 'next.ts'), 'export const a = 3\n')
      await rename(join(dir, 'next.ts'), file)
      expect(readSource(file).text).toBe('export const a = 3\n')

      await rm(file)
      expect(() => readSource(file)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
      forgetSources()
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads a file written a moment ago again at every call, as a second write could leave its stamp as it is', async () => {
    const dir = resolve(await scratchDir('kay-reads-'))
    const file = join(dir, 'a.ts')

    try {
      await Bun.write(file, 'export const a = 1\n')
      const first = readSource(file)

      expect(readSource(file)).not.toBe(first)
      settle(file)
      const settled = readSource(file)

      expect(readSource(file)).toBe(settled)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads a component as Bun does, the byte order mark left out', async () => {
    const dir = resolve(await scratchDir('kay-reads-'))
    const file = join(dir, 'a.kay')

    try {
      await Bun.write(file, '\uFEFF---\nimport \'./state\'\n---\np x\n')
      expect(readSource(file).text).toBe(await Bun.file(file).text())
      expect(readSource(file).text.startsWith('---')).toBe(true)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('forgets the files no read asked for since the last call', async () => {
    const dir = resolve(await scratchDir('kay-reads-'))
    const [kept, dropped] = [join(dir, 'kept.ts'), join(dir, 'dropped.ts')] as const

    try {
      await Bun.write(kept, 'export const k = 1\n')
      await Bun.write(dropped, 'export const d = 1\n')
      settle(kept, dropped)
      keepSources()
      const first = [readSource(kept), readSource(dropped)]

      keepSources()
      expect(readSource(kept)).toBe(first[0]!)
      keepSources()
      expect(readSource(kept)).toBe(first[0]!)
      expect(readSource(dropped)).not.toBe(first[1]!)
    }
    finally {
      forgetSources()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads the client sources of a rebuild again for a changed component and a changed library component or script it reaches', async () => {
    const project = await scratchProject({
      'package.json': JSON.stringify({ name: 'app', dependencies: { lib: '1.0.0' } }),
      'node_modules/lib/package.json': JSON.stringify({ name: 'lib', peerDependencies: { kay: '*' }, exports: { './*.kay': './*.kay' } }),
      'node_modules/lib/chip.kay': '---\nimport \'./colors\'\n---\np.chip-a x\n',
      'node_modules/lib/colors.ts': 'export const color = \'text-red-500\'\n',
      'src/routes/index.kay': '---\nimport Chip from \'lib/chip.kay\'\n---\nChip\n',
    })
    const graph = new Map()
    const classes = async () => [...(await readClientSources(project, {}, graph)).classes]

    try {
      expect(await classes()).toEqual(expect.arrayContaining(['chip-a', 'text-red-500']))

      await Bun.write(join(project, 'node_modules/lib/chip.kay'), '---\nimport \'./colors\'\n---\np.chip-b x\n')
      expect(await classes()).toEqual(expect.arrayContaining(['chip-b']))
      expect(await classes()).not.toContain('chip-a')

      await Bun.write(join(project, 'node_modules/lib/colors.ts'), 'export const color = \'text-blue-500\'\n')
      await Bun.write(join(project, 'src/routes/index.kay'), '---\nimport Chip from \'lib/chip.kay\'\n---\nChip\np.own-class y\n')
      const after = await classes()

      expect(after).toEqual(expect.arrayContaining(['text-blue-500', 'chip-b', 'own-class']))
      expect(after).not.toContain('text-red-500')
    }
    finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it('finds the runtime chunk once while the modules it was found in, and what the key says, stay as they were', async () => {
    const dir = resolve(await scratchDir('kay-runtime-'))
    const entry = join(dir, 'out/entry.ts')
    const island = join(dir, 'island.ts')
    const file = join(dir, 'cache/runtime.json')
    let searches = 0
    const counting = { name: 'counting', setup: () => void searches++ }
    const find = async (key = 'registry') => runtimeChunk(entry, { plugins: [counting], define: {}, external: [], cache: { file, key } })

    try {
      await Bun.write(entry, 'import \'../island\'\n')
      await Bun.write(island, 'import { signal } from \'kay\'\n\nexport const count = signal\n')
      settle(entry, island)
      const first = await find()

      expect(first?.anchor).toContain('signal as k')
      expect(first?.anchor).not.toContain('effect as k')
      expect(searches).toBe(1)

      // Asked again, it answers from the file without bundling.
      expect(await find()).toEqual(first)
      expect(searches).toBe(1)

      // A module it read now imports more of the runtime, at the same size and nothing telling the cache but its times.
      await Bun.write(island, 'import { effect } from \'kay\'\n\nexport const count = effect\n')
      settle(island)
      const second = await find()

      expect(searches).toBe(2)
      expect(second?.anchor).toContain('effect as k')
      expect(second?.anchor).not.toContain('signal as k')
      await find()
      expect(searches).toBe(2)

      // What the key says changed: the islands registered, the options.
      await find('another registry')
      expect(searches).toBe(3)

      // A module written a moment before the search may have changed after it read it: nothing is kept.
      await Bun.write(island, 'import { signal } from \'kay\'\n\nexport const count = signal\n')
      await find()
      await find()
      expect(searches).toBe(5)

      // A module it read is gone: the search fails, which the real build reports.
      await rm(island)
      expect(await find()).toBeUndefined()
      expect(searches).toBe(6)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('bundles the islands once to find the runtime chunk while a build\'s modules stay as they were, and again for another registry', async () => {
    const project = await scratchDir('kay-runtime-build-')
    const files = {
      'src/counter.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {n()}\n',
      'src/routes/index.kay': '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
    }
    let setups = 0
    const counting = { name: 'counting', setup: () => void setups++ }
    const searches = async () => {
      setups = 0
      await buildClient(project, { plugins: [counting] })

      return setups
    }

    try {
      await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(project, path), content)))
      settle(...Object.keys(files).map(path => join(project, path)))
      const cold = await searches()

      // The search is the extra bundle, beside the build and the stylesheets'.
      expect(await searches()).toBe(cold - 1)

      await Bun.write(join(project, 'src/extra.kay'), 'p.extra x\n')
      await Bun.write(join(project, 'src/routes/index.kay'), '---\nimport Counter from \'../counter.kay\'\nimport Extra from \'../extra.kay\'\n---\nCounter\nExtra\n')
      settle(join(project, 'src/extra.kay'), join(project, 'src/routes/index.kay'))
      expect(await searches()).toBe(cold - 1)
    }
    finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it('keeps what a module imports while its text stays, looking again for a module it imports that was missing', async () => {
    const dir = resolve(await scratchDir('kay-graph-'))
    const from = join(dir, 'a.ts')
    const target = join(dir, 'b.ts')
    const graph = new Map()

    try {
      await Bun.write(from, 'import \'./b\'\nimport \'node:fs\'\n')
      expect(await reachesAny(dir, [], from, new Set([target]), undefined, undefined, graph)).toBe(false)
      expect(graph.get(from)).toMatchObject({ paths: [], missing: ['./b'] })

      await Bun.write(target, '')
      expect(await reachesAny(dir, [], from, new Set([target]), undefined, undefined, graph)).toBe(true)

      await Bun.write(from, 'import \'node:fs\'\n')
      expect(await reachesAny(dir, [], from, new Set([target]), undefined, undefined, graph)).toBe(false)
      expect(graph.get(from)).toMatchObject({ paths: [], missing: [] })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('finds a module\'s imports again once a module it found is gone with no event, deleted or renamed', async () => {
    const dir = resolve(await scratchDir('kay-graph-'))
    const [a, b, c, renamed] = ['a.ts', 'b.ts', 'c.ts', 'e.ts'].map(name => join(dir, name)) as [string, string, string, string]
    const graph = new Map()

    try {
      await Bun.write(a, 'import \'./b\'\n')
      await Bun.write(b, 'import \'./c\'\n')
      await Bun.write(c, '')
      expect(await reachesAny(dir, [], a, new Set([c]), undefined, undefined, graph)).toBe(true)

      // As an install drops a library's component its importer still names.
      await rm(c)
      expect(await reachesAny(dir, [], a, new Set([c]), undefined, undefined, graph)).toBe(false)
      expect(graph.get(b)).toMatchObject({ paths: [], missing: ['./c'] })

      await rename(b, renamed)
      expect(await reachesAny(dir, [], a, new Set([renamed]), undefined, undefined, graph)).toBe(false)
      expect(graph.get(a)).toMatchObject({ paths: [], missing: ['./b'] })

      await Bun.write(a, 'import \'./e\'\n')
      expect(await reachesAny(dir, [], a, new Set([renamed]), undefined, undefined, graph)).toBe(true)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
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

  it('reports no JavaScript bundle for a site with no island', () => {
    expect(formatSizeReport({ islands: [] })).toBe('no JavaScript bundle: no page has an island')
  })
})

describe('the build report', () => {
  const summary = (routes: RouteSize[]): BuildSummary => ({ routes, stages: [{ name: 'check', ms: 4210 }, { name: 'bundle', ms: 87.4 }], caches: [{ name: 'image variants', cached: 40, made: 2 }, { name: 'components', cached: 0, made: 3 }] })
  const route = (pattern: string, js: number, css = 0, pages = 1): RouteSize => ({ route: pattern, js, css, pages, estimated: pages === 0 })

  it('shows one row per route with its scripts, stylesheets and whether it was prerendered, the change since the last build beside each size', () => {
    const previous: StoredReport = { version: 1, exported: false, entry: 10_240, islands: {}, routes: { '/': { js: 10_240, css: 1024 }, '/blog/:slug': { js: 5120, css: 0 } } }
    const printed = formatRouteTable([route('/', 13_517, 1024), route('/blog/:slug', 5120, 0, 200), route('/live', 2048, 0, 0), route('/new', 0, 512)], { previous })

    expect(printed).toMatch(/^Routes, gzip .*\n {2}route +rendered +JS +CSS\n/)
    expect(printed).toMatch(/^ {2}\/ +prerendered +13\.2 KB \[\+3\.2 KB\] +1\.0 KB$/m)
    // An unchanged size says nothing, and what the last build did not have is new.
    expect(printed).toMatch(/^ {2}\/blog\/:slug +prerendered x200 +5\.0 KB +0\.0 KB$/m)
    expect(printed).toMatch(/^ {2}\/live +on request +~2\.0 KB \[new\] +0\.0 KB \[new\]$/m)
    expect(formatRouteTable([route('/', 1024)])).not.toContain('[')
  })

  it('never runs past the width, shortening the middle of a long path and listing the lightest routes as a count', () => {
    const long = `/${'section/'.repeat(12)}:slug`
    const many = Array.from({ length: 30 }, (_, index) => route(`/page-${index}`, 1000 + index))
    const printed = formatRouteTable([route(long, 9000), ...many], { width: 70 })

    expect(Math.max(...printed.split('\n').map(line => line.length))).toBeLessThanOrEqual(70)
    expect(printed).toContain('/section/section/')
    expect(printed).toContain('...')
    expect(printed).toContain('and 6 more routes, lighter than these')
    expect(shorten('abcdefghij', 8)).toBe('ab...hij')
    expect(shorten('abc', 8)).toBe('abc')
  })

  it('prints the stages and what each cache answered as plain text, with no colour for a log', () => {
    const printed = formatBuildReport(undefined, summary([route('/', 1024)]))

    expect(printed).toContain('check   4.2 s')
    expect(printed).toContain('bundle  87 ms')
    expect(printed).toContain('image variants: 40 cached, 2 made')
    expect(printed).toContain('components:     0 cached, 3 made')
    // eslint-disable-next-line no-control-regex
    expect(printed).not.toMatch(/\x1B/)
  })

  it('compares the islands to the last build', () => {
    const report: SizeReport = { entry: { size: { raw: 9000, gzip: 4096 } }, islands: [{ file: 'src/a.kay', size: { raw: 3000, gzip: 2048 } }, { file: 'src/b.kay', size: { raw: 800, gzip: 400 } }] }
    const printed = formatSizeReport(report, { previous: { version: 1, exported: false, entry: 4096, islands: { 'src/a.kay': 1024 }, routes: {} } })

    expect(printed).toMatch(/^ {2}src\/a\.kay +\+2\.0 KB \(2\.9 KB\) \[\+1\.0 KB\]$/m)
    expect(printed).toMatch(/^ {2}src\/b\.kay +\+0\.4 KB \(0\.8 KB\) \[new\]$/m)
    expect(printed).toMatch(/^ {2}entry, loaded by every page with an island +4\.0 KB \(8\.8 KB\)$/m)
  })

  it('weighs only the build\'s own scripts a page names, whatever else its text holds', async () => {
    const dir = await scratchDir('route-sizes-')

    try {
      await Bun.write(join(dir, 'a.js'), 'export const a = 1\n'.repeat(50))
      await Bun.write(join(dir, '../outside.js'), 'x'.repeat(5000))

      const html = '<script type="module" src="/base/_kay/a.js"></script><p><a href="/_kay/%zz.js">x</a><a href="/_kay/../outside.js">y</a></p>'
      const sizes = await routeSizes('/app', { dir, styles: new Map() } as unknown as ClientBuild, [{ pattern: '/', file: '/app/src/routes/index.kay', params: [], layouts: [] } as unknown as Route], [{ path: '/', file: '/app/src/routes/index.kay', html } as RenderedPage], undefined)

      expect(sizes).toEqual([{ route: '/', js: Bun.gzipSync(await Bun.file(join(dir, 'a.js')).bytes(), { level: 9 }).length, css: 0, pages: 1, estimated: false }])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
      await rm(join(dir, '../outside.js'), { force: true })
    }
  })

  it('reads a route whose pages all answered another status as prerendered, with the scripts they load', async () => {
    const dir = await scratchDir('route-sizes-')

    try {
      await Bun.write(join(dir, 'a.js'), 'export const a = 1\n'.repeat(50))

      const route = { pattern: '/gone', file: '/app/src/routes/gone.kay', params: [], layouts: [] } as unknown as Route
      const sizes = await routeSizes('/app', { dir, styles: new Map() } as unknown as ClientBuild, [route], [], undefined, [{ file: route.file, html: '<script type="module" src="/_kay/a.js"></script>' }, { file: route.file, html: '' }])

      expect(sizes).toEqual([{ route: '/gone', js: expect.any(Number), css: 0, pages: 2, estimated: false }])
      expect(sizes[0]!.js).toBeGreaterThan(0)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('estimates an unprerendered route through helpers, dynamic imports and aliases, counts a shared chunk once, and charges the entry to a form or a deferred island', async () => {
    const dir = await scratchDir('route-sizes-')

    try {
      const chunk = async (name: string, size: number) => Bun.write(join(dir, 'out', name), Array.from({ length: size }, (_, index) => `export const v${index} = ${index * 7919 % 1013}\n`).join(''))

      await Promise.all([chunk('entry.js', 60), chunk('a.js', 40), chunk('b.js', 40), chunk('shared.js', 80)])
      await Promise.all(Object.entries({
        'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['src/*'] } } }),
        'src/a.kay': 'p A\n',
        'src/b.kay': 'p B\n',
        'src/lib/index.ts': 'export { default as A } from \'../a.kay\'\n',
        'src/routes/helper.kay': '---\nimport { A } from \'../lib/index\'\n---\nA\n',
        'src/routes/dynamic.kay': '---\nconst load = () => import(\'../b.kay\')\n---\np Dynamic\n',
        'src/routes/alias.kay': '---\nimport A from \'~/a.kay\'\n---\nA\n',
        'src/routes/both.kay': '---\nimport A from \'../a.kay\'\nimport B from \'../b.kay\'\n---\nA\nB\n',
        'src/routes/form.kay': 'form(action={add})\n  input(name="title")\n',
        'src/routes/defer.kay': '---\nimport A from \'../a.kay\'\n---\nA(server="defer")\n',
        'src/routes/plain.kay': 'p Plain\n',
      }).map(async ([path, content]) => Bun.write(join(dir, path), content)))

      const url = (name: string) => `/_kay/${name}`
      const report: SizeReport = {
        entry: { size: { raw: 0, gzip: 0 }, chunks: [url('entry.js')] },
        islands: [
          { file: 'src/a.kay', size: { raw: 0, gzip: 0 }, chunks: [url('a.js'), url('shared.js')] },
          { file: 'src/b.kay', size: { raw: 0, gzip: 0 }, chunks: [url('b.js'), url('shared.js')] },
        ],
      }
      const routes = ['helper', 'dynamic', 'alias', 'both', 'form', 'defer', 'plain'].map(name => ({ pattern: `/${name}`, file: join(dir, `src/routes/${name}.kay`), params: [], layouts: [] }) as unknown as Route)
      const sizes = Object.fromEntries((await routeSizes(dir, { dir: join(dir, 'out'), styles: new Map(), navigation: true } as unknown as ClientBuild, routes, [], report)).map(each => [each.route, each.js]))
      const [entry, a, b, shared] = await Promise.all(['entry.js', 'a.js', 'b.js', 'shared.js'].map(async name => gzipSize(await Bun.file(join(dir, 'out', name)).bytes())))

      expect(sizes['/helper']).toBe(entry! + a! + shared!)
      expect(sizes['/alias']).toBe(entry! + a! + shared!)
      expect(sizes['/dynamic']).toBe(entry! + b! + shared!)
      expect(sizes['/both']).toBe(entry! + a! + b! + shared!)
      expect(sizes['/form']).toBe(entry)
      expect(sizes['/defer']).toBe(entry! + a! + shared!)
      expect(sizes['/plain']).toBe(0)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lists what the last build had and this one does not', () => {
    const previous: StoredReport = { version: 1, exported: false, entry: 2048, islands: { 'src/a.kay': 1024, 'src/b.kay': 512 }, routes: { '/': { js: 1024, css: 0 }, '/old': { js: 512, css: 512 } } }
    const now = summary([route('/', 1024)])
    const printed = formatRemoved({ entry: { size: { raw: 0, gzip: 2048 } }, islands: [{ file: 'src/a.kay', size: { raw: 0, gzip: 1024 } }] }, now, previous)

    expect(printed).toBe('Removed since the last build:\n  island  src/b.kay  was 0.5 KB\n  route   /old  was 1.0 KB')
    expect(formatRemoved(undefined, now, previous)).toContain('entry   loaded by every page with an island  was 2.0 KB')
    expect(formatRemoved({ entry: { size: { raw: 0, gzip: 2048 } }, islands: [{ file: 'src/a.kay', size: { raw: 0, gzip: 0 } }, { file: 'src/b.kay', size: { raw: 0, gzip: 0 } }] }, summary([route('/', 1), route('/old', 1)]), previous)).toBe('')
    expect(formatRemoved(undefined, now, undefined)).toBe('')
    expect(formatBuildReport(undefined, now, { previous })).toContain('Removed since the last build:')
  })

  it('weighs each route, times the stages, counts what the caches answered, and keeps the sizes of the last good build only', async () => {
    const root = await scratchProject({
      'tsconfig.json': tsconfig,
      'src/counter.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {n()}\n',
      'src/page.css': '.page-marker { color: red }\n',
      'src/routes/index.kay': '--- server\nimport \'../page.css\'\n\nexport const page = { prerender: true }\n---\n---\nimport Counter from \'../counter.kay\'\n---\nhead\n  title Home\n  meta(name="description" content="Home")\nCounter\n',
      'src/routes/live.kay': '--- server\nconst path = ctx.url.pathname\n---\n---\nimport Counter from \'../counter.kay\'\n---\nhead\n  title Live\n  meta(name="description" content="Live")\nCounter\np {path}\n',
      'src/routes/plain.kay': '--- server\nexport const page = { prerender: true }\n---\nhead\n  title Plain\n  meta(name="description" content="Plain")\np Plain\n',
    })
    // In a process of its own, as the prerender registers the .kay loader for the project.
    const build = async (options: BuildOptions = {}) => {
      const script = `import { buildProject } from ${JSON.stringify(join(import.meta.dir, '../src/build/pipeline'))}\n\nconsole.log(JSON.stringify(await buildProject(${JSON.stringify(root)}, {}, ${JSON.stringify(options)})))\n`
      const child = Bun.spawn([process.execPath, '-e', script], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

      expect({ code, errors }).toEqual({ code: 0, errors: '' })

      return JSON.parse(output.trim().split('\n').at(-1)!) as BuildResult
    }
    const stored = projectPaths(root).report

    try {
      const firstResult = await build()
      const first = firstResult.built!
      const byRoute = Object.fromEntries(first.summary.routes.map(each => [each.route, each]))

      expect(first.previous).toBeUndefined()
      expect(byRoute['/']).toMatchObject({ pages: 1, estimated: false })
      expect(byRoute['/']!.js).toBeGreaterThan(0)
      expect(byRoute['/']!.css).toBeGreaterThan(0)
      expect(byRoute['/plain']).toMatchObject({ pages: 1, js: 0, css: 0 })
      // Not prerendered, so the scripts are what its components can load: the entry and the island.
      expect(byRoute['/live']).toMatchObject({ pages: 0, estimated: true })
      expect(byRoute['/live']!.js).toBe(byRoute['/']!.js)
      expect(first.summary.stages.map(stage => stage.name)).toEqual(['check', 'bundle', 'prerender', 'route sizes', 'images and cards', 'favicons', 'page hooks', 'compress'])
      expect(first.summary.stages.every(stage => stage.ms >= 0)).toBe(true)
      expect(first.summary.caches.find(cache => cache.name === 'components')).toBeDefined()
      expect(first.summary.caches.find(cache => cache.name === 'components')!.made).toBeGreaterThan(0)
      expect(existsSync(stored)).toBe(true)

      // Built again with nothing edited, everything compiled comes from the cache and the sizes are the same.
      const second = (await build()).built!
      const components = second.summary.caches.find(cache => cache.name === 'components')!

      expect(components.cached).toBeGreaterThan(0)
      expect(components.made).toBe(0)
      expect(second.previous!.routes['/']).toEqual({ js: byRoute['/']!.js, css: byRoute['/']!.css, estimated: false })
      expect(formatBuildReport(second.report, second.summary, { previous: second.previous })).not.toContain('[')

      // A failed build, the check refusing it, leaves the sizes of the last good one for the next to compare to.
      const kept = await Bun.file(stored).text()

      await Bun.write(join(root, 'src/routes/plain.kay'), '--- server\nexport const page = { prerender: true }\n---\na(href="/nowhere") Lost\n')
      expect((await build()).failed).toEqual({ stage: 'check' })
      expect(await Bun.file(stored).text()).toBe(kept)

      await Bun.write(join(root, 'src/routes/plain.kay'), '--- server\nexport const page = { prerender: true }\n---\nhead\n  title Plain\n  meta(name="description" content="Plain")\np Plain\n')
      await Bun.write(join(root, 'src/routes/extra.kay'), '--- server\nexport const page = { prerender: true }\n---\nhead\n  title Extra\n  meta(name="description" content="Extra")\np Extra\n')

      const third = (await build()).built!

      expect(third.previous!.routes['/extra']).toBeUndefined()
      expect(formatBuildReport(third.report, third.summary, { previous: third.previous })).toMatch(/^ {2}\/extra +prerendered +0\.0 KB \[new\] +0\.0 KB \[new\]$/m)

      // A static export weighs differently, so it is not compared to a server build.
      expect((await build({ exportTo: 'dist' })).built!.previous).toBeUndefined()
      expect((await build({ exportTo: 'dist' })).built!.previous).toBeDefined()
      // And each kind keeps its own, so switching between them loses neither.
      expect((await build()).built!.previous).toBeDefined()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
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

  it('resolves a symlinked folder in the path of a file that is gone too, as Bun keys its module cache', async () => {
    const dir = await scratchDir('real-path-')

    try {
      await mkdir(join(dir, 'real'))
      await symlink(join(dir, 'real'), join(dir, 'link'))

      const real = await realpath(dir)

      expect(realPath(join(dir, 'link/gone.ts'))).toBe(join(real, 'real/gone.ts'))
      expect(realPath(join(dir, 'link/a/b/gone.ts'))).toBe(join(real, 'real/a/b/gone.ts'))
    }
    finally {
      await rm(dir, { recursive: true, force: true })
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

  it('leaves no draft behind an atomic write that failed, was given up, or was swallowed by a cache or report writer', async () => {
    const dir = await scratchDir('atomic-')
    const file = join(dir, 'kept.txt')

    try {
      await Bun.write(file, 'before')
      await expect(writeAtomically(file, async (draft) => {
        await Bun.write(draft, 'half')

        throw new Error('cut short')
      })).rejects.toThrow('cut short')
      expect(await writeAtomically(file, async (draft) => {
        await Bun.write(draft, 'over the cap')

        return false
      })).toBe(false)
      expect(await Bun.file(file).text()).toBe('before')
      expect(await writeAtomically(file, 'after')).toBe(true)
      expect(await Bun.file(file).text()).toBe('after')

      // A directory where the file goes, which no rename replaces; the cache and the report swallow the failure.
      await mkdir(join(dir, 'taken'))
      await expect(writeAtomically(join(dir, 'taken'), 'x')).rejects.toThrow()
      await writeCacheEntry({ file: join(dir, 'taken'), key: 'k' }, 1)
      await writeStoredReport(join(dir, 'taken'), {} as StoredReport)
      expect((await readdir(dir)).sort()).toEqual(['kept.txt', 'taken'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('finds the class list it writes while another build of the process still reads .kay as it was before', async () => {
    const root = await scratchProject({ 'src/routes/index.kay': '---\nimport \'./theme.css\'\n---\np.note Hi\n', 'src/routes/theme.css': 'p { color: red }\n', '.kay/held.txt': '' })
    const listed = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    // Bun lists the directory of a file it resolves once for a build, and a build it starts meanwhile reads that listing.
    const holding = Bun.build({ entrypoints: [join(root, '.kay/held.txt')], throw: false, plugins: [{ name: 'hold', setup: build => void build.onLoad({ filter: /held\.txt$/ }, async () => {
      listed.resolve()
      await released.promise

      return { contents: '', loader: 'js' }
    }) }] })

    // Bun holds every build's plugins back while one's onLoad waits, so the held build lets go as the stylesheet build starts: a build started while another runs reads the listings that one took, whenever it ends.
    const started: BunPlugin = { name: 'started', setup: (build) => {
      if (build.config.entrypoints.some(entry => entry.endsWith('index.kay')))
        released.resolve()
    } }

    try {
      await listed.promise
      expect((await buildClient(root, { plugins: [started] })).styles.has(join(root, 'src/routes/index.kay'))).toBe(true)
    }
    finally {
      released.resolve()
      await holding
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails a build only once its stylesheets and islands both stopped, so neither writes into the next one', async () => {
    const root = await scratchProject({ 'src/routes/index.kay': '---\nimport \'./theme.css\'\n---\np Hi\n', 'src/routes/theme.css': 'p { color: red }\n' })
    let styled = false
    const plugin: BunPlugin = { name: 'slow', setup: (build) => {
      if (build.config.entrypoints.some(entry => entry.endsWith('entry.ts')))
        throw new Error('no islands')

      build.onLoad({ filter: /theme\.css$/ }, async () => {
        await Bun.sleep(100)
        styled = true

        return { contents: 'p { color: red }', loader: 'css' }
      })
    } }

    try {
      await expect(buildClient(root, { plugins: [plugin] })).rejects.toThrow('no islands')
      expect(styled).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('says an error\'s message when its stack starts with the name alone, in logs and on the page of a server failing to boot', () => {
    const error = new Error('database is locked')

    error.stack = 'Error\n    at claim (/app/src/jobs.ts:3:9)'
    expect(describeThrown(error)).toBe('Error: database is locked\n    at claim (/app/src/jobs.ts:3:9)')
    expect(compileErrorPage([], error)).toContain('<pre>Error: database is locked\n    at claim (/app/src/jobs.ts:3:9)</pre>')

    const stackless = new Error('no port free')

    stackless.stack = ''
    expect(compileErrorPage([], stackless)).toContain('<h1>no port free</h1>')
    expect(compileErrorPage([], stackless)).not.toContain('<pre>no port free</pre>')
    const bare = new Error('kept')

    bare.message = ''
    bare.stack = 'Error\n    at x (/a.ts:1:1)'
    expect(describeThrown(bare)).toBe('Error\n    at x (/a.ts:1:1)')
  })
})

describe('a compiled server\'s images', () => {
  it('encodes and decodes AVIF at run time with the coders the executable carries', async () => {
    const root = await scratchProject({
      'tsconfig.json': tsconfig,
      'kay.config.ts': 'export default { favicon: false, images: { dirs: { \'/uploads/\': \'uploads\' } } }\n',
      'src/routes/index.kay': '---\nimport { image } from \'kay/image\'\nimport hero from \'../hero.png\'\n---\nimg({...image(hero, { sizes: \'100vw\' })} alt="Hero")\n',
      // 48 pixels wide is no width the build writes, so the server encodes it on the first request.
      'src/server.ts': 'import process from \'node:process\'\nimport { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nconst app = new Elysia().use(await pages({ security: false }))\nconst page = await (await app.handle(new Request(\'http://localhost/\'))).text()\nconst src = /src=(%2F_kay%2Fassets%2F[^&]+)&amp;/.exec(page)![1]\nconst response = await app.handle(new Request(`http://localhost/_kay/image?src=${src}&w=48`, { headers: { accept: \'image/avif\' } }))\nconst bytes = new Uint8Array(await response.arrayBuffer())\nawait Bun.write(\'uploads/a.avif\', bytes)\nconst decoded = await app.handle(new Request(\'http://localhost/_kay/image?src=/uploads/a.avif&w=32\'))\n\nconsole.log(JSON.stringify({ status: response.status, type: response.headers.get(\'content-type\'), brand: new TextDecoder().decode(bytes.subarray(8, 12)), decoded: decoded.status }))\nprocess.exit(0)\n',
    })

    await Bun.write(join(root, 'src/hero.png'), encodePng(new Uint8Array(96 * 64 * 4).map((_, at) => at % 4 === 3 ? 255 : (at * 37) % 251), 96, 64))

    try {
      const [report, code] = await printed(Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, '--compile', join(root, 'server')], { stdout: 'pipe', stderr: 'pipe' }))

      expect(report).not.toContain('error')
      expect(code).toBe(0)
      // The coders' wasm is embedded zstd-compressed, and no other wasm is in this executable.
      expect(Buffer.from(await Bun.file(join(root, 'server')).arrayBuffer()).includes(Buffer.from([0, 0x61, 0x73, 0x6D, 1, 0, 0, 0]))).toBe(false)

      const child = Bun.spawn([join(root, 'server')], { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, stdout: 'pipe', stderr: 'pipe' })
      const [output, errors, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

      expect({ exit, errors }).toEqual({ exit: 0, errors: expect.any(String) })
      expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({ status: 200, type: 'image/avif', brand: 'avif', decoded: 200 })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
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
      // Each imported as text and for its effect too, in either order: the server's, a page's, an island's.
      'src/shared.css': '.shared { color: plum }\n',
      'src/other.css': '.other { color: olive }\n',
      'src/tag.css': '.tag-text { color: navy }\n',
      'src/tag-plain.ts': 'import \'./tag.css\'\n',
      'src/badge.kay': '---\nimport { signal } from \'kay\'\nimport badge from \'./badge.css\' with { type: \'text\' }\nimport \'./tag-plain\'\nimport tag from \'./tag.css\' with { type: \'text\' }\n\nconst on = signal(false)\n---\nbutton(onClick={() => on.set(o => !o)}) {on() ? badge + tag : badge.length}\n',
      'src/routes/a.kay': '--- server\nimport other from \'../other.css\' with { type: \'text\' }\n---\np.other {other.length}\n',
      'src/routes/z.kay': '---\nimport \'../other.css\'\n---\np Z\n',
      'src/routes/index.kay': '---\nimport \'../app.css\'\nimport \'../shared.css\'\nimport Badge from \'../badge.kay\'\n---\n--- server\nimport theme from \'../theme.css\' with { type: \'text\' }\n\nconst size: number = theme.length\n---\np.size {size}\nBadge\n',
      'src/server.ts': 'import process from \'node:process\'\nimport { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\nimport shared from \'./shared.css\' with { type: \'text\' }\nimport theme from \'./theme.css\' with { type: \'text\' }\n\nconst { default: later } = await import(\'./later.css\', { with: { type: \'text\' } })\nconst app = new Elysia().use(await pages({ security: false }))\nconst page = await (await app.handle(new Request(\'http://localhost/\'))).text()\nconst other = await (await app.handle(new Request(\'http://localhost/a\'))).text()\n\nconsole.log(JSON.stringify({ theme, later, shared, page: /<p class="size">(\\d+)<\\/p>/.exec(page)?.[1], other: /<p class="other">(\\d+)<\\/p>/.exec(other)?.[1] }))\nprocess.exit(0)\n',
    })
    const theme = await Bun.file(join(root, 'src/theme.css')).text()
    const read = async (command: string[]) => {
      const child = Bun.spawn(command, { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, stdout: 'pipe', stderr: 'pipe' })
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

      expect({ code, errors }).toEqual({ code: 0, errors: expect.any(String) })

      return JSON.parse(output.trim().split('\n').at(-1)!) as { theme: string, later: string, shared: string, page: string, other: string }
    }

    try {
      const built = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, '--compile', join(root, 'server')], { stdout: 'pipe', stderr: 'pipe' })
      const [report, code] = await printed(built)

      expect(report).not.toContain('error')
      expect(code).toBe(0)
      const expected = { theme, later: '.later { color: green }\n', shared: '.shared { color: plum }\n', page: String(theme.length), other: String('.other { color: olive }\n'.length) }

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
      expect(scripts).toContain('.tag-text { color: navy }')
      expect(scripts).not.toContain('.app { color')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('a compiled server', () => {
  it('boots with its sources gone, each layout\'s actions behind the guards of its own directory, a library\'s too, rendering an extension\'s editor with its stylesheet, serving the icons drawn from an SVG favicon and a share card with an SVG logo without resvg, and printing the notices of what it ships', async () => {
    const secret = 'a-preview-secret-long-enough-for-kay-0123456789'
    const action = (name: string, settings = '') => `--- server\nimport { t } from 'elysia'\nimport { action } from 'kay'\n\n${settings}export const ${name} = action(t.Object({}), () => '${name}')\n---\nslot\n`
    const root = await scratchProject({
      'package.json': JSON.stringify({ name: 'notices', private: true, dependencies: { elysia: '*' }, devDependencies: { '@iconify-json/tabler': '*' } }),
      'tsconfig.json': tsconfig,
      'kay.config.ts': `export default { favicon: 'src/favicon.svg', images: { card: { logo: 'src/favicon.svg' } }, requireGuards: true, preview: { secret: '${secret}' }, fonts: [{ fontsource: '@fontsource/inter', weights: [700] }], extensions: [{ name: 'lib', routes: { dir: 'lib/routes', prefix: '/lib' }, editor: \`\${import.meta.dir}/lib/editor.kay\` }] }\n`,
      'src/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#c00"/></svg>',
      'lib/editor.css': '.edited { outline: 1px dashed teal }\n',
      'lib/editor.kay': '---\nimport { signal } from \'kay\'\nimport \'./editor.css\'\n\nconst clicks = signal(0)\n---\nbutton.edited(onClick={() => clicks.set(n => n + 1)}) Edit {clicks()}\n',
      'lib/routes/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'x-lib\'))\n    deny(403)\n})\n',
      'lib/routes/_layout.kay': action('track'),
      'lib/routes/index.kay': 'h1 Library\n',
      'src/encoded.kay': '---\nimport { signal } from \'kay\'\nimport { stringify } from \'devalue\'\n\nconst on = signal(false)\n---\nbutton(onClick={() => on.set(o => !o)}) {on() ? stringify([1]) : \'off\'}\n',
      'src/routes/_layout.kay': action('leave', 'export const page = { guards: false }\n'),
      'src/routes/index.kay': '---\nimport { shareCard } from \'kay/image\'\nimport Encoded from \'../encoded.kay\'\n---\n--- server\nexport const page = { guards: false }\n---\nhead\n  meta(property="og:image" content={shareCard({ title: \'Home\' })})\nh1 Home\nEncoded\n',
      'src/routes/staff/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'x-admin\'))\n    deny(403, \'Admins only\')\n})\n',
      'src/routes/staff/_layout.kay': action('promote'),
      'src/routes/staff/sign-in.kay': '--- server\nexport const page = { guards: false }\n---\nh1 Staff\n',
      'src/server.ts': `import process from 'node:process'
import { Elysia } from 'elysia'
import { pages, previewUrl } from 'kay/server'

const app = new Elysia().use(await pages({ security: false }))
const get = async (path: string, cookie = '') => app.handle(new Request(\`http://localhost\${path}\`, { headers: { cookie } }))
const post = async (file: string, name: string, headers: Record<string, string> = {}) => (await app.handle(new Request(\`http://localhost/_kay/action/src/routes/\${file}/\${name}\`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'referer': 'http://localhost/', ...headers }, body: '[{}]' }))).status
const cookie = (await get(previewUrl('/', { edit: true }))).headers.getSetCookie()[0]!.split(';')[0]!
const page = await (await get('/', cookie)).text()
const sheets = [...page.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => match[1]!)
const styles = (await Promise.all(sheets.map(async sheet => (await get(sheet)).text()))).join('')
const icons = await Promise.all(['/favicon.ico', '/icon-512.png', '/favicon.svg'].map(async path => (await get(path)).status))
const card = new URL(page.split('property="og:image" content="')[1]!.split('"')[0]!.replaceAll('&amp;', '&'), 'http://localhost')
const drawn = await get(card.pathname + card.search)

console.log(JSON.stringify({ home: (await get('/')).status, leave: await post('_layout.kay', 'leave'), promote: await post('staff/_layout.kay', 'promote'), admin: await post('staff/_layout.kay', 'promote', { 'x-admin': '1' }), track: await post('../../lib/routes/_layout.kay', 'track'), tracked: await post('../../lib/routes/_layout.kay', 'track', { 'x-lib': '1' }), editor: page.includes('class="edited"'), sheet: styles.includes('dashed teal'), icons, card: [drawn.status, drawn.headers.get('content-type')] }))
process.exit(0)
`,
    })

    try {
      const [report, code] = await printed(Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, '--no-check', '--compile', join(root, 'server')], { stdout: 'pipe', stderr: 'pipe' }))

      expect(report).not.toContain('error')
      expect(code).toBe(0)

      const client = await Bun.file(join(clientDir(root), 'THIRD-PARTY-LICENSES.txt')).text()

      expect(client).toContain('\ndevalue ')
      expect(client).toContain('@fontsource/inter ')
      expect(client).toContain('SIL Open Font License')
      expect(client).toContain('@iconify-json/tabler ')
      expect(client).toContain('Tabler Icons by Paweł Kuna')
      // The server's own packages are no business of the browser's.
      expect(client).not.toContain('\nelysia ')

      const served = new Elysia()

      await serveBuildFiles(served, { dir: clientDir(root) } as ClientBuild, { dev: false, security: undefined })

      const response = await served.handle(new Request('http://localhost/_kay/THIRD-PARTY-LICENSES.txt'))

      expect(response.status).toBe(200)
      // Named the same from one build to the next, so it is asked for again each time.
      expect(response.headers.get('cache-control')).toBe('no-cache')
      expect(await response.text()).toBe(client)

      const executable = Bun.spawn([join(root, 'server'), '--licenses'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const [printedNotices, exitCode] = await Promise.all([new Response(executable.stdout).text(), executable.exited])

      expect(exitCode).toBe(0)
      expect(printedNotices).toContain('\nelysia ')
      expect(printedNotices).toContain('\ndevalue ')
      expect(printedNotices).toContain('@fontsource/inter ')

      // The executable reads nothing from the sources, the layouts' settings and the favicon included.
      await rename(join(root, 'src'), join(root, 'moved'))
      await rename(join(root, 'lib'), join(root, 'moved-lib'))
      const child = Bun.spawn([join(root, 'server')], { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, stdout: 'pipe', stderr: 'pipe' })
      const [output, errors, exited] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

      expect({ exited, errors }).toEqual({ exited: 0, errors: expect.any(String) })
      expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({ home: 200, leave: 200, promote: 403, admin: 200, track: 403, tracked: 200, editor: true, sheet: true, icons: [200, 200, 200], card: [200, 'image/jpeg'] })
      expect((await Bun.file(join(root, 'server')).text()).includes('resvg-js')).toBe(false)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('codec licences', () => {
  const avif = join(import.meta.dir, '../node_modules/@jsquash/avif')

  it('adds the licences of the codecs the AVIF wasm compiles in to the package\'s own', () => {
    const notices = thirdPartyNotices([avif])

    expect(notices).toContain('@jsquash/avif 2.1.1 (Apache-2.0)')
    expect(notices).toContain('Copyright 2019 Joe Drago')
    expect(notices).toContain('Copyright (c) 2016, Alliance for Open Media')
    expect(notices).toContain('Alliance for Open Media Patent License 1.0')
    expect(notices).toContain('Emscripten is available under 2 licenses')
    expect(notices).toContain('musl as a whole is licensed under the following standard MIT license')
    // Only its decoder ships, which compiles no libsharpyuv.
    expect(notices).not.toContain('Additional IP Rights Grant (Patents)')
  })

  it('carries the texts of kay\'s own AVIF encoder with kay\'s licence', () => {
    const notices = thirdPartyNotices([join(import.meta.dir, '..')])

    expect(notices).toContain('Files: third_party/iccjpeg/*')
    expect(notices).toContain('Copyright (c) 2010, Google Inc.')
    expect(notices).toContain('Additional IP Rights Grant (Patents)')
    expect(notices).toContain('LICENSES/musl-emscripten-6.0.12.txt')
  })

  it('knows the installed version of every package it holds codec licences for', () => {
    expect(unknownCodecVersions([avif])).toEqual([])
  })

  it('reports a version the map does not hold, and adds nothing for it', async () => {
    const dir = await scratchDir('avif-')

    try {
      await Bun.write(join(dir, 'package.json'), JSON.stringify({ name: '@jsquash/avif', version: '2.1.2', license: 'Apache-2.0' }))

      expect(unknownCodecVersions([dir])).toEqual(['@jsquash/avif@2.1.2'])
      expect(thirdPartyNotices([dir])).not.toContain('Alliance for Open Media')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('names only files that exist in LICENSES', async () => {
    const files = Object.values(BUNDLED_LICENCES).flatMap(versions => Object.values(versions).flatMap(codecs => codecs.flatMap(codec => codec.files)))

    expect(files.length).toBeGreaterThan(0)

    for (const file of files)
      expect(existsSync(join(import.meta.dir, '../LICENSES', file))).toBe(true)
  })

  it('leaves the codec warning to the build stage, so a compiled build prints it once', async () => {
    expect(await Bun.file(join(import.meta.dir, '../src/build/compile.ts')).text()).not.toContain('codecWarnings')
  })

  it('warns of an installed version it holds no texts for, and of none otherwise', async () => {
    const root = await scratchDir('avif-warn-')

    try {
      await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@jsquash/avif': '*' } }))
      await Bun.write(join(root, 'node_modules/@jsquash/avif/package.json'), JSON.stringify({ name: '@jsquash/avif', version: '2.1.2' }))

      expect(codecWarnings(root)).toEqual([expect.stringContaining('@jsquash/avif@2.1.2 is a version kay holds no codec licence texts for')])

      await Bun.write(join(root, 'node_modules/@jsquash/avif/package.json'), JSON.stringify({ name: '@jsquash/avif', version: '2.1.1' }))

      expect(codecWarnings(root)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('pruning the compile caches', () => {
  it('drops the entries of a deleted component and entry file after a full build, and keeps the others', async () => {
    const root = resolve(await fixtureCopy('content'))
    const cache = join(root, '.kay/cache')
    const build = async () => {
      const script = `import { buildProject } from ${JSON.stringify(join(import.meta.dir, '../src/build/pipeline'))}\n\nawait buildProject(${JSON.stringify(root)}, {}, { check: false })\n`
      const child = Bun.spawn([process.execPath, '-e', script], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

      expect({ code, errors }).toEqual({ code: 0, errors: '' })
    }
    const listing = async () => ({ compiled: (await readdir(cache)).filter(name => name.endsWith('.json') && !name.startsWith('runtime-search')).sort(), content: (await readdir(join(cache, 'content'))).sort() })

    try {
      await build()

      const baseline = await listing()

      await Bun.write(join(root, 'src/components/gone.kay'), 'p Gone\n')
      await Bun.write(join(root, 'src/content/posts/gone.md'), '---\ntitle: Gone\ndate: 2020-01-01\n---\nGone\n')
      await build()

      const grown = await listing()

      expect(grown.compiled.length).toBeGreaterThan(baseline.compiled.length)
      expect(grown.content.length).toBe(baseline.content.length + 1)

      await rm(join(root, 'src/components/gone.kay'))
      await rm(join(root, 'src/content/posts/gone.md'))
      await build()
      expect(await listing()).toEqual(baseline)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('prunes nothing before a build analysed the components, and never what it read or wrote', async () => {
    const cacheDir = await scratchDir('prune-')
    const file = join(cacheDir, 'a.kay')
    const stale = join(cacheDir, '1abc-ssr.json')
    const checks = join(cacheDir, '1abc-shadow.json')

    // Other tests of this file analysed components in this process.
    keepAnalyses(new Set())

    try {
      await Bun.write(stale, '{}')
      await Bun.write(checks, '{}')
      expect(await pruneCompileCache(cacheDir)).toBe(0)
      await transformKayCached('p A\n', file, { target: 'ssr', cacheDir, root: cacheDir })
      await analyzeKayCached('p A\n', file, cacheDir, cacheDir)

      // A variant of a live component the build did not use stays.
      const variant = `${Bun.hash(file).toString(36)}-ssr-inspect.json`

      await Bun.write(join(cacheDir, variant), '{}')
      expect(await pruneCompileCache(cacheDir)).toBe(1)
      expect(await Bun.file(join(cacheDir, variant)).exists()).toBe(true)

      const left = await readdir(cacheDir)

      expect(left).toHaveLength(4)
      expect(left).toContain('1abc-shadow.json')
      expect(left).not.toContain('1abc-ssr.json')
    }
    finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})
