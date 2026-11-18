import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

import { renameProjectFiles } from '../src/check/renamed-packages'
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

describe('renameProjectFiles', () => {
  it('writes the names `kay upgrade` must move before the installed kay runs, and leaves the strings of data', async () => {
    await withFiles({ 'src/a.ts': 'import \'@kaynooo/kayjs-ui\'\nconst data = \'@kaynooo/kayjs-ui\'\n', 'package.json': '{ "dependencies": { "@kaynooo/kayjs-ui": "~1.103.0" } }\n' }, async (root) => {
      await renameProjectFiles(root)
      expect(await read(root, 'src/a.ts')).toBe('import \'@kayjs/ui\'\nconst data = \'@kaynooo/kayjs-ui\'\n')
      expect(await read(root, 'package.json')).toBe('{ "dependencies": { "@kaynooo/kayjs-ui": "~1.103.0" } }\n')
    })
  })
})

describe('renameProjectFiles reach', () => {
  it('writes a specifier of every form, a config key and a tsconfig string, and no other string of data', async () => {
    const data = [
      'const kind = (dependencies: Record<string, string>) => \'@kaynooo/kayjs\' in dependencies ? \'kay\' : \'bun\'',
      'const RENAMED: Record<string, string> = { \'@kaynooo/kayjs\': \'@kayjs/kay\', \'@kaynooo/kayjs-ai\': \'1.62.0\' }',
      'const note = \'@kaynooo/kayjs-ui\'',
      '// import \'@kaynooo/kayjs-ui\'',
      '',
    ].join('\n')

    await withFiles({
      'src/a.ts': 'import a from \'@kaynooo/kayjs\'\nexport * from \'@kaynooo/kayjs-cms\'\nconst d = require(\'@kaynooo/kayjs-ai\')\nconst e = await import(\'@kaynooo/kayjs-auth\')\nmock.module(\'@kaynooo/kayjs-ui\', () => ({}))\n',
      'src/data.ts': data,
      'src/page.kay': '---\nimport { cms } from \'@kaynooo/kayjs-cms\'\nconst name = \'@kaynooo/kayjs-cms\'\n---\np {name}\n',
      'src/config.ts': 'export default { librarySettings: { \'@kaynooo/kayjs-ui\': \'./ui.ts\' } }\n',
      'tsconfig.json': '{ "extends": "@kaynooo/kayjs/tsconfig.json" }\n',
      'src/app.css': '@import \'@kaynooo/kayjs-ui/theme.css\';\n.a::after { content: \'@kaynooo/kayjs-ui\' }\n',
    }, async (root) => {
      await renameProjectFiles(root)
      expect(await read(root, 'src/a.ts')).toBe('import a from \'@kayjs/kay\'\nexport * from \'@kayjs/cms\'\nconst d = require(\'@kayjs/ai\')\nconst e = await import(\'@kayjs/auth\')\nmock.module(\'@kayjs/ui\', () => ({}))\n')
      expect(await read(root, 'src/data.ts')).toBe(data)
      expect(await read(root, 'src/page.kay')).toBe('---\nimport { cms } from \'@kayjs/cms\'\nconst name = \'@kaynooo/kayjs-cms\'\n---\np {name}\n')
      expect(await read(root, 'src/config.ts')).toBe('export default { librarySettings: { \'@kayjs/ui\': \'./ui.ts\' } }\n')
      expect(await read(root, 'tsconfig.json')).toBe('{ "extends": "@kayjs/kay/tsconfig.json" }\n')
      expect(await read(root, 'src/app.css')).toBe('@import \'@kayjs/ui/theme.css\';\n.a::after { content: \'@kaynooo/kayjs-ui\' }\n')
    })
  })
})
