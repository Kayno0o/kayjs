import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes, check } from '../src/check'
import { moduleImportEdits } from '../src/check/missing-imports'
import { compileKay } from '../src/compiler'
import { kayTypes } from './kay-types'
import { scratchDir } from './scratch'

describe('a name a file uses with no import', () => {
  it('writes an import into a module: into the entry\'s own, after the last specifier, else before the first import', () => {
    const apply = (source: string, wanted: Record<string, string[]>) => moduleImportEdits(source, new Map(Object.entries(wanted))).toSorted((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)

    expect(apply('import { s } from \'kay/server\'\n\nexport const a = [s, files]\n', { 'kay/server': ['files'] })).toBe('import { s, files } from \'kay/server\'\n\nexport const a = [s, files]\n')
    expect(apply('import {\n  s,\n} from "kay/server"\n', { 'kay/server': ['files', 'pages'] })).toBe('import {\n  s, files, pages,\n} from "kay/server"\n')
    expect(apply('import type { Row } from \'kay/server\'\nimport { x } from \'./x\'\n', { 'kay/server': ['files'], 'kay': ['signal'] })).toBe('import { files } from \'kay/server\'\nimport { signal } from \'kay\'\nimport type { Row } from \'kay/server\'\nimport { x } from \'./x\'\n')
    expect(apply('#!/usr/bin/env bun\n// header\nexport const a = 1\n', { kay: ['signal'] })).toBe('#!/usr/bin/env bun\nimport { signal } from \'kay\'\n\n// header\nexport const a = 1\n')
    expect(apply('import { x } from "./x";\n', { kay: ['signal'] })).toBe('import { signal } from "kay";\nimport { x } from "./x";\n')
  })

  async function project(files: Record<string, string>): Promise<string> {
    const root = await scratchDir('missing-imports-')
    const tsconfig = JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, paths: kayTypes() }, include: ['src', '.kay/types'] })

    await Promise.all(Object.entries({ 'tsconfig.json': tsconfig, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    return root
  }

  it('is a type error in a component, as in a module, and the import writes it away', async () => {
    const root = await project({
      'src/routes/index.kay': '---\nconst count = signal(0)\n---\np {count()} {t(\'home.title\')}\n',
      'src/components/imported.kay': '---\nimport { signal } from \'kay\'\nimport { t } from \'kay/i18n\'\n\nconst count = signal(0)\n---\np {count()} {t(\'home.title\')}\n',
      'src/components/plain.kay': 'p {signal}\n',
    })

    try {
      const found = (await check(root)).filter(diagnostic => diagnostic.message.startsWith('Cannot find name'))

      expect(found.map(diagnostic => [diagnostic.file.slice(root.length + 1), diagnostic.message]).toSorted()).toEqual([
        ['src/components/plain.kay', 'Cannot find name \'signal\'.'],
        ['src/routes/index.kay', 'Cannot find name \'signal\'.'],
        ['src/routes/index.kay', 'Cannot find name \'t\'.'],
      ])
      expect(await applySafeFixes(root, found)).toBeGreaterThan(0)
      expect((await check(root)).filter(diagnostic => diagnostic.message.startsWith('Cannot find name'))).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes the import in the file\'s own line ending, after a directive, and into the server fence of a file that has no other', async () => {
    const root = await project({
      'src/routes/crlf.kay': '---\r\nconst count = signal(0)\r\n---\r\np {count()}\r\n',
      'src/routes/directive.kay': '---\n\'use strict\'\n\nconst count = signal(0)\n---\np {count()}\n',
      'src/routes/server-only.kay': '--- server\nconst a = 1\n---\np {a} {uid()}\n',
    })

    try {
      const found = (await check(root)).filter(diagnostic => diagnostic.message.startsWith('Cannot find name'))

      expect(await applySafeFixes(root, found)).toBeGreaterThan(0)
      expect(await Bun.file(join(root, 'src/routes/crlf.kay')).text()).toBe('---\r\nimport { signal } from \'kay\'\r\n\r\nconst count = signal(0)\r\n---\r\np {count()}\r\n')
      expect(await Bun.file(join(root, 'src/routes/directive.kay')).text()).toBe('---\n\'use strict\'\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\np {count()}\n')
      expect(await Bun.file(join(root, 'src/routes/server-only.kay')).text()).toBe('--- server\nimport { uid } from \'kay\'\n\nconst a = 1\n---\np {a} {uid()}\n')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('adds no import to the compiled component', () => {
    expect(compileKay('---\nconst count = signal(0)\n---\np {count()}\n', 'src/components/part.kay').tsx).not.toContain('import { signal }')
    expect(compileKay('p {t(\'a\')}\n', 'src/components/part.kay').tsx).not.toContain('kay/i18n')
  })

  it('is what `kay check --fix` does in a `.ts` file and in a `.kay` file, the project clean afterwards', async () => {
    const root = await project({
      'src/total.ts': 'import { onMount } from \'kay\'\n\nexport const total = memo(() => 1)\nexport const keep = [onMount, signal(0)]\nexport const where = cached\nexport const own = (files: string) => files\n',
      'src/routes/index.kay': '--- server\nconst all = await cached(\'k\', \'5m\', async () => [1])\n---\nh1 {all.length}\n',
    })

    try {
      const found = await check(root)

      expect(found.filter(diagnostic => diagnostic.code === 'TS2304' || diagnostic.message.startsWith('Cannot find name')).map(diagnostic => diagnostic.fixes?.[0]?.safe)).toEqual([true, true, true, true])
      expect(await applySafeFixes(root, found)).toBeGreaterThan(0)
      expect(await Bun.file(join(root, 'src/total.ts')).text()).toBe('import { cached } from \'kay/cache\'\nimport { onMount, memo, signal } from \'kay\'\n\nexport const total = memo(() => 1)\nexport const keep = [onMount, signal(0)]\nexport const where = cached\nexport const own = (files: string) => files\n')
      expect(await Bun.file(join(root, 'src/routes/index.kay')).text()).toBe('--- server\nimport { cached } from \'kay/cache\'\n\nconst all = await cached(\'k\', \'5m\', async () => [1])\n---\nh1 {all.length}\n')
      expect((await check(root)).map(diagnostic => diagnostic.message)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('offers a generic name\'s import without applying it unasked', async () => {
    const root = await project({ 'src/a.ts': 'export const a = session\n' })

    try {
      const found = await check(root)

      expect(found.map(diagnostic => [diagnostic.message.slice(0, 28), diagnostic.fixes?.[0]?.safe])).toEqual([['Cannot find name \'session\'.', false]])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a name no entry exports and a name the file declares', async () => {
    const root = await project({ 'src/a.ts': 'export const a = nothingHere\nconst files = 1\nexport const b = files\n' })

    try {
      const found = await check(root)

      expect(found.map(diagnostic => [diagnostic.message, diagnostic.fixes])).toEqual([['Cannot find name \'nothingHere\'.', undefined]])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
