import type { BunPlugin } from 'bun'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { describe, expect, it } from 'bun:test'
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

  it('bundles the islands for production and writes the manifest a server boots from', async () => {
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root], { stdout: 'pipe', stderr: 'pipe' })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
      const manifest = await Bun.file(join(root, '.kay/client/manifest.json')).json() as { entry: string, islands: Record<string, string[]> }
      const entry = await Bun.file(join(root, '.kay/client/dist', manifest.entry.slice('/_kay/'.length))).text()

      expect(code).toBe(0)
      expect(errors).toStartWith('built 1 island and 0 stylesheets in ')
      expect(Object.keys(manifest.islands)).toEqual(['counter.kay'])
      // Minified: no line of the bundle is indented.
      expect(entry).not.toContain('\n  ')
    }
    finally {
      await rm(join(root, '.kay'), { recursive: true, force: true })
    }
  })
})
