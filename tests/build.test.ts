import type { BunPlugin } from 'bun'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { describe, expect, it } from 'bun:test'
import { clientDir, writeAsset } from '../src/build/assets'
import { mapStack } from '../src/build/sourcemap'
import { analyzeKayCached, transformKayCached } from '../src/build/transform'
import { buildClient } from '../src/server/client'

const root = join(import.meta.dir, 'fixtures/islands')

describe('kay build', () => {
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

  it('bundles the islands for production and writes the manifest a server boots from', async () => {
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root], { stdout: 'pipe', stderr: 'pipe' })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
      const manifest = await Bun.file(join(root, '.kay/client/manifest.json')).json() as { entry: string, islands: Record<string, string[]> }
      const entry = await Bun.file(join(root, '.kay/client/dist', manifest.entry.slice('/_kay/'.length))).text()

      expect(code).toBe(0)
      expect(errors).toStartWith('built 2 islands, 0 stylesheets and 0 prerendered pages in ')
      expect(Object.keys(manifest.islands).sort()).toEqual(['counter.kay', 'greeting.kay'])
      // Minified: no line of the bundle is indented.
      expect(entry).not.toContain('\n  ')
    }
    finally {
      await rm(join(root, '.kay'), { recursive: true, force: true })
    }
  })
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
    const source = '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton.counter(onClick={() => count.set(c => c + 1)}) {count()}\n'

    try {
      const dom = await transformKayCached(source, file, { target: 'dom', cacheDir, root: cacheDir })
      const otherRoot = await transformKayCached(source, file, { target: 'dom', cacheDir, root: dirname(cacheDir) })

      expect(otherRoot).not.toBe(dom)
      expect(await transformKayCached(source, file, { target: 'dom', cacheDir, root: cacheDir })).toBe(dom)
      expect(await transformKayCached(source, file, { target: 'dom', hydratable: true, cacheDir, root: cacheDir })).not.toBe(dom)
      expect(await transformKayCached(source, file, { target: 'ssr', cacheDir, root: cacheDir })).not.toBe(dom)

      const analysis = await analyzeKayCached(source, file, cacheDir, cacheDir)

      expect(analysis).toMatchObject({ island: 'counter.kay', classes: ['counter'], diagnostics: [] })
      expect(await analyzeKayCached(source, file, cacheDir, cacheDir)).toEqual(analysis)
      expect((await analyzeKayCached('for t of list\n  li x\n', file, cacheDir, cacheDir)).diagnostics).not.toHaveLength(0)
      expect(await analyzeKayCached(source, file, cacheDir, cacheDir)).toEqual(analysis)
      expect((await readdir(cacheDir)).sort()).toEqual([expect.stringMatching(/-analysis\.json$/), expect.stringMatching(/-dom-hydratable\.json$/), expect.stringMatching(/-dom\.json$/), expect.stringMatching(/-ssr\.json$/)])
    }
    finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})
