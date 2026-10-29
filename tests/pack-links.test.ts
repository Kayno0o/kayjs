import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { $ } from 'bun'
import { describe, expect, it } from 'bun:test'
import { restore, rewrite, rewriteLinks } from '../scripts/pack-links'
import { scratchDir } from './scratch'

const ROOT = join(import.meta.dir, '..')
const LINK = /\]\((?!\w+:|\/|#)([^)\s#]+\.(?:md|txt))(?:#[^)\s]*)?\)/g
const FOLDERS = new Map([['', 'kayjs'], ['packages/ui', 'kayjs-ui'], ['packages/cms', 'kayjs-cms']])

async function packages(): Promise<string[]> {
  return ['', ...(await readdir(join(ROOT, 'packages'))).map(name => `packages/${name}`)].filter(folder => existsSync(join(ROOT, folder, 'package.json')))
}

describe('rewriteLinks', () => {
  it('points a link into another package at its folder in node_modules/@kaynooo', () => {
    expect(rewriteLinks('llms/recipes.md', '[a](../packages/cms/llms/loaders.md#x)', FOLDERS)).toBe('[a](../../kayjs-cms/llms/loaders.md#x)')
    expect(rewriteLinks('llms.txt', '[a](packages/ui/llms.txt)', FOLDERS)).toBe('[a](../kayjs-ui/llms.txt)')
    expect(rewriteLinks('packages/cms/llms/history.md', '[a](../../../llms/content.md)', FOLDERS)).toBe('[a](../../kayjs/llms/content.md)')
    expect(rewriteLinks('packages/cms/llms/history.md', '[a](../../ui/llms/basics.md)', FOLDERS)).toBe('[a](../../kayjs-ui/llms/basics.md)')
  })

  it('leaves a link inside a package, a URL, an anchor and a path out of the repo alone', () => {
    for (const link of ['[a](content.md#x)', '[a](../README.md)', '[a](https://x.fr/a.md)', '[a](#top)', '[a](/guides/x)'])
      expect(rewriteLinks('llms/recipes.md', link, FOLDERS)).toBe(link)

    expect(rewriteLinks('packages/cms/llms/history.md', '[a](../fields.md)', FOLDERS)).toBe('[a](../fields.md)')
  })
})

describe('packed tarballs', () => {
  it('resolve every link of the shipped docs from node_modules/@kaynooo', async () => {
    const mirror = await scratchDir('pack-links-')
    const tarballs = join(mirror, 'tarballs')
    const installed = join(mirror, 'node_modules', '@kaynooo')
    const names = new Map<string, string>()

    // The docs and manifests alone, with the manifests' scripts and dependencies dropped so a pack here builds and resolves nothing.
    for (const folder of await packages()) {
      const manifest = await Bun.file(join(ROOT, folder, 'package.json')).json() as Record<string, unknown> & { name: string }

      for (const field of ['scripts', 'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'peerDependenciesMeta'])
        delete manifest[field]

      names.set(folder, manifest.name)
      await mkdir(join(mirror, folder), { recursive: true })
      await Bun.write(join(mirror, folder, 'package.json'), JSON.stringify(manifest))

      for (const entry of ['llms', 'llms.txt', 'README.md']) {
        if (existsSync(join(ROOT, folder, entry)))
          await cp(join(ROOT, folder, entry), join(mirror, folder, entry), { recursive: true })
      }
    }

    await rewrite(mirror)

    const installedDocs: [string, string][] = []

    for (const [folder, name] of names) {
      await $`bun pm pack --destination ${tarballs} --quiet --ignore-scripts`.cwd(join(mirror, folder)).quiet()

      const target = join(installed, name.replace('@kaynooo/', ''))
      const tarball = (await readdir(tarballs)).find(file => file.startsWith(`${name.replace('@', '').replace('/', '-')}-`))

      await mkdir(target, { recursive: true })
      await $`tar -xzf ${join(tarballs, tarball!)} --strip-components=1 -C ${target}`.quiet()

      // kay's own README links the examples and benchmarks of the repo, which only the forge serves.
      const docs = ['llms.txt', 'README.md', ...new Bun.Glob('llms/*.md').scanSync({ cwd: target })].filter(file => existsSync(join(target, file))).filter(file => folder !== '' || file !== 'README.md')

      installedDocs.push(...docs.map((doc): [string, string] => [name, join(target, doc)]))
    }

    let followed = 0
    const broken: string[] = []

    // Followed once every package is installed, as an app's node_modules holds them.
    for (const [name, doc] of installedDocs) {
      for (const [, link] of (await readFile(doc, 'utf8')).matchAll(LINK)) {
        followed++

        if (!existsSync(resolve(dirname(doc), link!)))
          broken.push(`${name}/${relative(installed, doc)}: ${link}`)
      }
    }

    expect(followed).toBeGreaterThan(100)
    expect(broken).toEqual([])

    await restore(mirror)
  })

  it('are packed through scripts that rewrite the links and restore the files', async () => {
    for (const folder of await packages()) {
      const { scripts } = await Bun.file(join(ROOT, folder, 'package.json')).json() as { scripts: Record<string, string> }

      expect(scripts.prepack).toContain('pack-links.ts rewrite')
      expect(scripts.postpack).toContain('pack-links.ts restore')
    }
  })

  it('restore the repo\'s own links', async () => {
    const mirror = await scratchDir('pack-links-restore-')

    await mkdir(join(mirror, 'llms'), { recursive: true })
    await mkdir(join(mirror, 'packages', 'ui'), { recursive: true })
    await Bun.write(join(mirror, 'packages', 'ui', 'package.json'), '{"name":"@kaynooo/kayjs-ui"}')
    await Bun.write(join(mirror, 'llms.txt'), '[a](packages/ui/llms.txt)')
    await rewrite(mirror)
    expect(await Bun.file(join(mirror, 'llms.txt')).text()).toBe('[a](../kayjs-ui/llms.txt)')
    await restore(mirror)
    expect(await Bun.file(join(mirror, 'llms.txt')).text()).toBe('[a](packages/ui/llms.txt)')
  })
})
