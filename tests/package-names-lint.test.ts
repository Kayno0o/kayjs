import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes } from '../src/check'
import { renamedPackages, renameProjectFiles } from '../src/check/renamed-packages'
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

  it('reports a specifier, a config key or a manifest entry, not a string or a comment that mentions an old name', async () => {
    await withFiles({
      'src/a.ts': [
        '// moved from @kaynooo/kayjs-ui to @kayjs/ui',
        '/* @kaynooo/kayjs-cms',
        '   @kaynooo/kayjs-mail */',
        'const note = \'use @kaynooo/kayjs-ui instead\'',
        'const url = \'https://example.com/@kaynooo/kayjs-ui\' // @kaynooo/kayjs-ai',
        'import \'@kaynooo/kayjs-auth\'',
        '',
      ].join('\n'),
      'src/app.css': '/* @kaynooo/kayjs-ui */\n@source \'../node_modules/@kaynooo/kayjs-ui/src\';\n',
      'package.json': '{ "name": "@kaynooo/kayjs-ui", "description": "a fork of @kaynooo/kayjs-cms", "dependencies": { "@kaynooo/kayjs-ai": "~1.103.0" } }\n',
    }, async (root) => {
      const found = await renamedPackages(root, undefined)

      expect(found.map(d => [d.file.slice(root.length + 1), d.line, d.message.slice(0, 22)])).toEqual([
        ['package.json', 1, '`@kaynooo/kayjs-ai` is'],
        ['src/a.ts', 6, '`@kaynooo/kayjs-auth` '],
        ['src/app.css', 2, '`@kaynooo/kayjs-ui` is'],
      ])
    })
  })

  it('writes the new names with the safe fixes, and the project then holds no old name', async () => {
    await withFiles({
      'package.json': '{ "dependencies": { "@kaynooo/kayjs-ui": "~1.103.0", "@kaynooo/pg-orm": "^8.1.4" }, "devDependencies": { "kay": "npm:@kaynooo/kayjs@~1.103.0" } }\n',
      'src/page.kay': '---\nimport Table from \'@kaynooo/kayjs-ui/table.kay\'\nimport { cms } from \'@kaynooo/kayjs-cms\'\n---\nTable\n',
    }, async (root) => {
      expect(await applySafeFixes(root, await renamedPackages(root, undefined))).toBe(4)
      expect(await read(root, 'package.json')).toBe('{ "dependencies": { "@kayjs/ui": "~1.104.0", "@kaynooo/pg-orm": "^8.1.4" }, "devDependencies": { "kay": "npm:@kayjs/kay@~1.104.0" } }\n')
      expect(await read(root, 'src/page.kay')).toBe('---\nimport Table from \'@kayjs/ui/table.kay\'\nimport { cms } from \'@kayjs/cms\'\n---\nTable\n')
      expect(await renamedPackages(root, undefined)).toEqual([])
    })
  })

  it('raises a manifest range below 1.104 to it, keeping its form, and leaves one at or above it', async () => {
    await withFiles({ 'package.json': '{ "dependencies": { "@kaynooo/kayjs-ui": "^1.103.2", "@kaynooo/kayjs-cms": "~1.104.1" }, "devDependencies": { "kay": "npm:@kaynooo/kayjs@~1.90.0" } }\n' }, async (root) => {
      await applySafeFixes(root, await renamedPackages(root, undefined))
      expect(await read(root, 'package.json')).toBe('{ "dependencies": { "@kayjs/ui": "^1.104.0", "@kayjs/cms": "~1.104.1" }, "devDependencies": { "kay": "npm:@kayjs/kay@~1.104.0" } }\n')
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

describe('deprecated-package-names reach', () => {
  it('leaves an old name inside string data alone: an `in` check, a table of renames and a fixture', async () => {
    const source = [
      'const kind = (dependencies: Record<string, string>) => \'@kaynooo/kayjs\' in dependencies ? \'kay\' : \'bun\'',
      'const RENAMED: Record<string, string> = { \'@kaynooo/kayjs\': \'@kayjs/kay\', \'@kaynooo/kayjs-ui\': \'@kayjs/ui\' }',
      'const facts = [{ name: \'@kaynooo/kayjs\', version: \'1.62.0\' }]',
      'expect(rename(\'@kaynooo/kayjs-ui\')).toBe(`@kayjs/ui`)',
      '',
    ].join('\n')

    await withFiles({ 'src/conventions.ts': source, 'tests/bump.test.ts': source }, async (root) => {
      expect(await renamedPackages(root, undefined)).toEqual([])
    })
  })

  it('writes a specifier of every form and no other string of a file', async () => {
    await withFiles({
      'src/a.ts': [
        'import a from \'@kaynooo/kayjs\'',
        'import type { B } from "@kaynooo/kayjs-ui/types"',
        'export * from \'@kaynooo/kayjs-cms\'',
        'export { c } from \'@kaynooo/kayjs-mail\'',
        'const d = require(\'@kaynooo/kayjs-ai\')',
        'const e = await import(\'@kaynooo/kayjs-auth\')',
        'type F = typeof import(\'@kaynooo/kayjs-ui\')',
        'mock.module(\'@kaynooo/kayjs-ui\', () => ({}))',
        'const note = \'@kaynooo/kayjs-ui\'',
        'const list = [\'@kaynooo/kayjs-ui\']',
        '',
      ].join('\n'),
      'src/page.kay': '---\nimport { cms } from \'@kaynooo/kayjs-cms\'\nconst name = \'@kaynooo/kayjs-cms\'\n---\np {name}\n',
      'kay.config.ts': 'export default { \'@kaynooo/kayjs-ui/button.kay\': { parts: {} }, label: \'@kaynooo/kayjs-ui\' }\n',
      'src/app.css': '@import \'@kaynooo/kayjs-ui/theme.css\';\n@plugin "@kaynooo/kayjs-ui/plugin";\n.a::after { content: \'@kaynooo/kayjs-ui\' }\n',
    }, async (root) => {
      const found = await renamedPackages(root, undefined)

      expect(found.map(d => [d.file.slice(root.length + 1), d.line])).toEqual([
        ['kay.config.ts', 1],
        ['src/a.ts', 1],
        ['src/a.ts', 2],
        ['src/a.ts', 3],
        ['src/a.ts', 4],
        ['src/a.ts', 5],
        ['src/a.ts', 6],
        ['src/a.ts', 7],
        ['src/a.ts', 8],
        ['src/app.css', 1],
        ['src/app.css', 2],
        ['src/page.kay', 2],
      ])
      expect(await applySafeFixes(root, found)).toBe(12)
      expect(await read(root, 'src/a.ts')).toContain('const note = \'@kaynooo/kayjs-ui\'\nconst list = [\'@kaynooo/kayjs-ui\']')
      expect(await read(root, 'src/page.kay')).toBe('---\nimport { cms } from \'@kayjs/cms\'\nconst name = \'@kaynooo/kayjs-cms\'\n---\np {name}\n')
      expect(await read(root, 'src/app.css')).toBe('@import \'@kayjs/ui/theme.css\';\n@plugin "@kayjs/ui/plugin";\n.a::after { content: \'@kaynooo/kayjs-ui\' }\n')
    })
  })
})
describe('deprecated-package-names keys and tsconfig', () => {
  it('finds a config key whatever it is keyed to but a table of renames or versions, and every string of a tsconfig', async () => {
    await withFiles({
      'src/config.ts': 'export default { librarySettings: { \'@kaynooo/kayjs-ui\': \'./ui.ts\' }, ui: { \'@kaynooo/kayjs-ui/button.kay\': Custom, \'@kaynooo/kayjs-ui/card.kay\': false }, RENAMED: { \'@kaynooo/kayjs-cms\': \'@kayjs/cms\', \'@kaynooo/kayjs-ai\': \'1.62.0\' } }\n',
      'tsconfig.json': '{ "extends": "@kaynooo/kayjs/tsconfig.json", "compilerOptions": { "types": ["@kaynooo/kayjs"], "paths": { "@kaynooo/kayjs-ui/*": ["./x"] } } }\n',
    }, async (root) => {
      const found = await renamedPackages(root, undefined)

      expect(found.map(d => [d.file.slice(root.length + 1), d.message.slice(0, 22)])).toEqual([
        ['src/config.ts', '`@kaynooo/kayjs-ui` is'],
        ['src/config.ts', '`@kaynooo/kayjs-ui` is'],
        ['src/config.ts', '`@kaynooo/kayjs-ui` is'],
        ['tsconfig.json', '`@kaynooo/kayjs` is `@'],
        ['tsconfig.json', '`@kaynooo/kayjs` is `@'],
        ['tsconfig.json', '`@kaynooo/kayjs-ui` is'],
      ])
    })
  })
})

describe('renameProjectFiles', () => {
  it('writes the names `kay upgrade` must move before the installed kay runs, and leaves the strings of data', async () => {
    await withFiles({ 'src/a.ts': 'import \'@kaynooo/kayjs-ui\'\nconst data = \'@kaynooo/kayjs-ui\'\n', 'package.json': '{ "dependencies": { "@kaynooo/kayjs-ui": "~1.103.0" } }\n' }, async (root) => {
      await renameProjectFiles(root)
      expect(await read(root, 'src/a.ts')).toBe('import \'@kayjs/ui\'\nconst data = \'@kaynooo/kayjs-ui\'\n')
      expect(await read(root, 'package.json')).toBe('{ "dependencies": { "@kaynooo/kayjs-ui": "~1.103.0" } }\n')
    })
  })
})
