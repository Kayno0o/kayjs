import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check'
import { renamedPackages } from '../src/check/renamed-packages'
import { OLD_PACKAGE_NAME, RENAMED_PACKAGES, renamePackages } from '../src/package-names'
import { scratchDir } from './scratch'

async function withFiles<T>(files: Record<string, string>, run: (root: string) => Promise<T>): Promise<T> {
  const root = await scratchDir('package-names-')

  try {
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    return await run(root)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

const read = async (root: string, path: string) => Bun.file(join(root, path)).text()

describe('renamePackages', () => {
  it('writes the new name of kay and of each library, whole names only', () => {
    expect(renamePackages('npm:@kaynooo/kayjs@~1.103.0 @kaynooo/kayjs-ui/button.kay @kaynooo/kayjs-cms')).toBe('npm:@kayjs/kay@~1.103.0 @kayjs/ui/button.kay @kayjs/cms')
    expect(renamePackages('@kaynooo/kayjs-uikit @kaynooo/kayjs-ui2 @kaynooo/kayjs-fake @kaynooo/pg-orm @kayjs/ui')).toBe('@kaynooo/kayjs-uikit @kaynooo/kayjs-ui2 @kaynooo/kayjs-fake @kaynooo/pg-orm @kayjs/ui')
  })

  it('names every package of the workspace once', async () => {
    const names = await Promise.all(['', 'packages/ui/', 'packages/auth/', 'packages/mail/', 'packages/cms/', 'packages/ai/'].map(async dir => ((await Bun.file(join(import.meta.dir, '..', dir, 'package.json')).json()) as { name: string }).name))

    expect(names.toSorted()).toEqual(Object.values(RENAMED_PACKAGES).toSorted())
    expect(Object.keys(RENAMED_PACKAGES).every(name => new RegExp(`^${OLD_PACKAGE_NAME.source}$`).test(name))).toBe(true)
  })
})

describe('deprecated-package-names', () => {
  it('reports each old name of a script, a component, a stylesheet and the manifest, at its line and column', async () => {
    await withFiles({
      'package.json': '{\n  "dependencies": {\n    "@kaynooo/kayjs-ui": "~1.103.0"\n  },\n  "devDependencies": { "kay": "npm:@kaynooo/kayjs@~1.103.0" }\n}\n',
      'src/ui.ts': 'export default { \'@kaynooo/kayjs-ui/button.kay\': { parts: {} } }\n',
      'src/routes/index.kay': '---\nimport Button from \'@kaynooo/kayjs-ui/button.kay\'\n---\nButton Hi\n',
      'src/app.css': '@import \'@kaynooo/kayjs-ui/theme.css\';\n',
      'node_modules/x/index.ts': 'import \'@kaynooo/kayjs-ui\'\n',
    }, async (root) => {
      const found = await renamedPackages(root, undefined)

      expect(found.map(d => [d.file.slice(root.length + 1), d.line, d.column, d.severity, d.message])).toEqual([
        ['package.json', 3, 6, 'warning', '`@kaynooo/kayjs-ui` is `@kayjs/ui` since 1.104: kay and its libraries are published under the `@kayjs` scope'],
        ['package.json', 5, 36, 'warning', '`@kaynooo/kayjs` is `@kayjs/kay` since 1.104: kay and its libraries are published under the `@kayjs` scope'],
        ['src/app.css', 1, 10, 'warning', '`@kaynooo/kayjs-ui` is `@kayjs/ui` since 1.104: kay and its libraries are published under the `@kayjs` scope'],
        ['src/routes/index.kay', 2, 21, 'warning', '`@kaynooo/kayjs-ui` is `@kayjs/ui` since 1.104: kay and its libraries are published under the `@kayjs` scope'],
        ['src/ui.ts', 1, 19, 'warning', '`@kaynooo/kayjs-ui` is `@kayjs/ui` since 1.104: kay and its libraries are published under the `@kayjs` scope'],
      ])
    })
  })

  it('writes the new names with the safe fixes, and the project then holds no old name', async () => {
    await withFiles({
      'package.json': '{ "dependencies": { "@kaynooo/kayjs-ui": "~1.103.0", "@kaynooo/pg-orm": "^8.1.4" }, "devDependencies": { "kay": "npm:@kaynooo/kayjs@~1.103.0" } }\n',
      'src/page.kay': '---\nimport Table from \'@kaynooo/kayjs-ui/table.kay\'\nimport { cms } from \'@kaynooo/kayjs-cms\'\n---\nTable\n',
    }, async (root) => {
      expect(await applySafeFixes(root, await renamedPackages(root, undefined))).toBe(4)
      expect(await read(root, 'package.json')).toBe('{ "dependencies": { "@kayjs/ui": "~1.103.0", "@kaynooo/pg-orm": "^8.1.4" }, "devDependencies": { "kay": "npm:@kayjs/kay@~1.103.0" } }\n')
      expect(await read(root, 'src/page.kay')).toBe('---\nimport Table from \'@kayjs/ui/table.kay\'\nimport { cms } from \'@kayjs/cms\'\n---\nTable\n')
      expect(await renamedPackages(root, undefined)).toEqual([])
    })
  })

  it('leaves a manifest that lists the new name already to be fixed by hand, as the rename would write the entry twice', async () => {
    await withFiles({ 'package.json': '{ "dependencies": { "@kaynooo/kayjs-ui": "~1.103.0", "@kayjs/ui": "~1.104.0" } }\n' }, async (root) => {
      const found = await renamedPackages(root, undefined)

      expect(found.map(d => d.fixes![0]!.safe)).toEqual([false])
      expect(await applySafeFixes(root, found)).toBe(0)
    })
  })

  it('takes the level the config gives, allow dropping it', async () => {
    await withFiles({ 'src/a.ts': 'import \'@kaynooo/kayjs-ui\'\n' }, async (root) => {
      expect((await renamedPackages(root, { 'deprecated-package-names': 'deny' })).map(d => d.severity)).toEqual(['error'])
      expect(await renamedPackages(root, { deprecated: 'allow' })).toEqual([])
      expect(await renamedPackages(root, { 'deprecated-package-names': 'allow' })).toEqual([])
    })
  })
})
