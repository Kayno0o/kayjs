import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { $ } from 'bun'
import { describe, expect, it } from 'bun:test'
import { restore, restoreAfter, rewrite, rewriteLinks } from '../scripts/pack-links'
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

describe('rewriteLinks in Markdown that is not a plain inline link', () => {
  it('leaves fenced code, code spans and the links of a longer fence alone', () => {
    const text = ['[a](packages/ui/llms.txt)', '```md', '[b](packages/ui/llms.txt)', '```', '~~~~', '[c](packages/ui/llms.txt)', '~~~', '[d](packages/ui/llms.txt)', '~~~~', 'use `[e](packages/ui/llms.txt)` or [f](packages/ui/llms.txt) after'].join('\n')

    expect(rewriteLinks('llms.txt', text, FOLDERS).split('\n')).toEqual(['[a](../kayjs-ui/llms.txt)', '```md', '[b](packages/ui/llms.txt)', '```', '~~~~', '[c](packages/ui/llms.txt)', '~~~', '[d](packages/ui/llms.txt)', '~~~~', 'use `[e](packages/ui/llms.txt)` or [f](../kayjs-ui/llms.txt) after'])
  })

  it('rewrites reference definitions and titled links like inline ones', () => {
    expect(rewriteLinks('llms.txt', '[ui]: packages/ui/llms.txt#top "UI"\n[web]: https://x.fr/a.md\n[a](packages/ui/llms.txt "title") and [b](packages/ui/llms.txt \'t\')', FOLDERS)).toBe('[ui]: ../kayjs-ui/llms.txt#top "UI"\n[web]: https://x.fr/a.md\n[a](../kayjs-ui/llms.txt "title") and [b](../kayjs-ui/llms.txt \'t\')')
  })
})

describe('the backup of a pack', () => {
  async function repo(): Promise<string> {
    const mirror = await scratchDir('pack-links-backup-')

    await mkdir(join(mirror, 'llms'), { recursive: true })

    for (const name of ['ui', 'cms']) {
      await mkdir(join(mirror, 'packages', name), { recursive: true })
      await Bun.write(join(mirror, 'packages', name, 'package.json'), `{"name":"@kaynooo/kayjs-${name}"}`)
      await Bun.write(join(mirror, 'packages', name, 'llms.txt'), '[a](../../llms.txt) [b](../cms/llms.txt)')
    }

    await Bun.write(join(mirror, 'llms.txt'), '[a](packages/ui/llms.txt)')

    return mirror
  }

  it('is restored when the rewrite itself fails half way', async () => {
    const mirror = await repo()

    await Bun.write(join(mirror, 'packages', 'cms', 'README.md'), '[a](../ui/llms.txt)')
    await mkdir(join(mirror, 'packages', 'ui', 'llms', 'dir.md'), { recursive: true })
    // A folder named like a Markdown file cannot be read as one.
    await expect(rewrite(mirror)).rejects.toThrow()
    expect(await Bun.file(join(mirror, 'llms.txt')).text()).toBe('[a](packages/ui/llms.txt)')
    expect(await Bun.file(join(mirror, 'packages', 'cms', 'README.md')).text()).toBe('[a](../ui/llms.txt)')
    expect(existsSync(join(mirror, 'node_modules', '.cache', 'pack-links', '(all)'))).toBe(false)
  })

  it('is one per package, so a second pack does not undo the first', async () => {
    const mirror = await repo()

    await rewrite(mirror, 'packages/ui')
    await rewrite(mirror, 'packages/cms')
    expect(await Bun.file(join(mirror, 'packages', 'ui', 'llms.txt')).text()).toBe('[a](../kayjs/llms.txt) [b](../kayjs-cms/llms.txt)')
    expect(await Bun.file(join(mirror, 'llms.txt')).text()).toBe('[a](packages/ui/llms.txt)')
    await restore(mirror, 'packages/cms')
    expect(await Bun.file(join(mirror, 'packages', 'cms', 'llms.txt')).text()).toBe('[a](../../llms.txt) [b](../cms/llms.txt)')
    expect(await Bun.file(join(mirror, 'packages', 'ui', 'llms.txt')).text()).toBe('[a](../kayjs/llms.txt) [b](../kayjs-cms/llms.txt)')
    await restore(mirror, 'packages/ui')
    expect(await Bun.file(join(mirror, 'packages', 'ui', 'llms.txt')).text()).toBe('[a](../../llms.txt) [b](../cms/llms.txt)')
  })

  it('is put back once the pack that made it is gone, though no postpack ran', async () => {
    const mirror = await repo()
    const pack = Bun.spawn(['sleep', '1'])

    await rewrite(mirror, '', pack.pid)
    expect(await Bun.file(join(mirror, 'llms.txt')).text()).toBe('[a](../kayjs-ui/llms.txt)')
    // Another pack's backup is not this one's to restore.
    await restoreAfter(process.pid + 1_000_000, mirror, '')
    expect(await Bun.file(join(mirror, 'llms.txt')).text()).toBe('[a](../kayjs-ui/llms.txt)')
    await restoreAfter(pack.pid, mirror, '')
    expect(await Bun.file(join(mirror, 'llms.txt')).text()).toBe('[a](packages/ui/llms.txt)')
  })
})
