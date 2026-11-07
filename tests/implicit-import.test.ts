import type { Diagnostic } from '../src/compiler/ast'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { applySafeFixes, check } from '../src/check'
import { moduleImportEdits } from '../src/check/missing-imports'
import { compileKay } from '../src/compiler'
import { scratchDir } from './scratch'

const page = 'src/routes/page.kay'
const found = (source: string, options = {}, filename = page) => compileKay(source, filename, { check: true, ...options }).diagnostics.filter(diagnostic => diagnostic.code === 'implicit-import')
const apply = (source: string, diagnostics: Diagnostic[]) => diagnostics.flatMap(diagnostic => diagnostic.fixes![0]!.edits).toSorted((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)
const fixed = (source: string, filename = page) => apply(source, found(source, {}, filename))

describe('the implicit-import lint', () => {
  it('names a kay value the script reads with no import, at its first use, and writes the import at the fence start', () => {
    const source = '---\n// a signal(0) comment\nconst count = signal(0)\n---\nbutton(onClick={() => count++}) {count()}\n'
    const [lint] = found(source)

    expect(found(source)).toHaveLength(1)
    expect(source.slice(lint!.start, lint!.end)).toBe('signal')
    expect(source.slice(0, lint!.start)).toContain('const count = ')
    expect(lint).toMatchObject({ checkOnly: true, fixes: [{ safe: true }] })
    expect(fixed(source)).toBe('---\nimport { signal } from \'kay\'\n\n// a signal(0) comment\nconst count = signal(0)\n---\nbutton(onClick={() => count++}) {count()}\n')
  })

  it('writes the file\'s own line endings', () => {
    expect(fixed('---\r\nconst a = signal(0)\r\n---\r\np {a()}\r\n')).toBe('---\r\nimport { signal } from \'kay\'\r\n\r\nconst a = signal(0)\r\n---\r\np {a()}\r\n')
    expect(fixed('p {uid()}\r\n')).toBe('---\r\nimport { uid } from \'kay\'\r\n---\r\np {uid()}\r\n')
    expect(moduleImportEdits('import { x } from \'./x\'\r\n', new Map([['kay', ['signal']]]))[0]!.text).toBe('import { signal } from \'kay\'\r\n')
  })

  it('says nothing of a name already imported, aliased, type-only imported, declared or only written in a string, a comment or a key', () => {
    expect(found('---\nimport { signal } from \'kay\'\nconst a = signal(0)\n---\np {a()}\n')).toEqual([])
    expect(found('---\nimport { signal as sig } from \'kay\'\nconst a = sig(0)\n---\np {a()}\n')).toEqual([])
    expect(found('---\nimport type { signal } from \'kay\'\nconst a: typeof signal | undefined = undefined\n---\np {a}\n')).toEqual([])
    expect(found('---\nconst uid = () => 1\nfunction memo() { return 2 }\n---\np {uid()} {memo()}\n')).toEqual([])
    expect(found('---\nconst { route } = props<{ route: string }>()\nconst note = \'signal(0)\' // memo(1)\nconst o = { signal: 1 }\n---\np {route} {note} {o.signal}\n')).toEqual([])
  })

  it('merges into the kay import the file has, after the last value specifier, aliased, multi-line or with a trailing comma', () => {
    expect(fixed('---\nimport { signal as sig } from \'kay\'\nconst a = sig(0), b = memo(() => a())\n---\np {b()}\n')).toBe('---\nimport { signal as sig, memo } from \'kay\'\nconst a = sig(0), b = memo(() => a())\n---\np {b()}\n')
    expect(fixed('---\nimport {\n  signal,\n  type Signal,\n} from \'kay\'\nconst a: Signal<number> = signal(0), b = memo(() => a())\n---\np {b()}\n')).toBe('---\nimport {\n  signal, memo,\n  type Signal,\n} from \'kay\'\nconst a: Signal<number> = signal(0), b = memo(() => a())\n---\np {b()}\n')
    // A type-only import is no place for a value.
    expect(fixed('---\nimport type { Signal } from \'kay\'\nconst a: Signal<number> = signal(0)\n---\np {a()}\n')).toBe('---\nimport { signal } from \'kay\'\nimport type { Signal } from \'kay\'\nconst a: Signal<number> = signal(0)\n---\np {a()}\n')
  })

  it('puts `t` in an import of `kay/i18n` and the rest in `kay`, one diagnostic for a fence', () => {
    const source = '---\nconst a = signal(0)\n---\np {t(\'hi\')} {a()}\n'

    expect(found(source)).toHaveLength(1)
    expect(found(source)[0]!.message).toContain('`signal`, `t`')
    expect(fixed(source)).toBe('---\nimport { signal } from \'kay\'\nimport { t } from \'kay/i18n\'\n\nconst a = signal(0)\n---\np {t(\'hi\')} {a()}\n')
    expect(fixed('---\nimport { t } from \'kay/i18n\'\nconst a = signal(0)\n---\np {t(\'hi\')} {a()}\n')).toBe('---\nimport { signal } from \'kay\'\nimport { t } from \'kay/i18n\'\nconst a = signal(0)\n---\np {t(\'hi\')} {a()}\n')
    expect(found('---\nimport { t as tr } from \'kay/i18n\'\n---\np {tr(\'hi\')}\n')).toEqual([])
    expect(found('---\nconst t = (key: string) => key\n---\np {t(\'hi\')}\n')).toEqual([])
  })

  it('opens a fence for a template with no script and for a page with only a server fence, and writes a server fence\'s names there', () => {
    expect(fixed('p {uid()}\n')).toBe('---\nimport { uid } from \'kay\'\n---\np {uid()}\n')
    expect(fixed('--- server\nconst id = uid()\n---\np {id} {route(\'a\')}\n')).toBe('--- server\nimport { uid, route } from \'kay\'\n\nconst id = uid()\n---\np {id} {route(\'a\')}\n')
    expect(fixed('--- server\nimport { s } from \'kay\'\n---\nh1 {route(\'a\')}\n')).toBe('--- server\nimport { s, route } from \'kay\'\n---\nh1 {route(\'a\')}\n')
    expect(fixed('--- module\nexport const id = uid()\n---\np {id}\n')).toBe('--- module\nimport { uid } from \'kay\'\n\nexport const id = uid()\n---\np {id}\n')
    expect(fixed('--- island\n---\np {uid()}\n')).toBe('--- island\nimport { uid } from \'kay\'\n---\np {uid()}\n')
  })

  it('reads the names in a markdown block and edits the author\'s file', () => {
    const source = 'markdown\n  # Hello {uid()}\n'
    const lints = found(source)

    expect(lints).toHaveLength(1)
    expect(fixed(source)).toBe('---\nimport { uid } from \'kay\'\n---\nmarkdown\n  # Hello {uid()}\n')
  })

  it('keeps the role of the component and its output, and reports nothing the second time', () => {
    for (const source of ['---\nconst count = signal(0)\n---\nbutton(onClick={() => count++}) {count()}\n', 'p {uid()}\n']) {
      const again = fixed(source)

      for (const output of [undefined, 'html', 'dom'] as const) {
        const before = compileKay(source, page, { output })
        const after = compileKay(again, page, { output })

        expect(Boolean(after.island)).toBe(Boolean(before.island))
        expect(after.diagnostics).toEqual([])
      }

      expect(found(again)).toEqual([])
      expect(compileKay(source, page, { check: true }).island === undefined).toBe(compileKay(again, page, { check: true }).island === undefined)
    }

    expect(compileKay('---\nconst a = signal(0)\n---\np {a()}\n', page, { output: 'html' }).diagnostics).toEqual([])
  })

  it('is a compile-time check only, honours the level and `kay-allow`', () => {
    const source = '---\nconst a = signal(0)\n---\np {a()}\n'

    expect(compileKay(source, page).diagnostics).toEqual([])
    expect(found(source, { lints: { 'implicit-import': 'allow' } })).toEqual([])
    expect(found(source, { lints: { 'implicit-import': 'deny' } })[0]).toMatchObject({ code: 'implicit-import' })
    expect(found('---\n// kay-allow implicit-import\nconst a = signal(0)\n---\np {a()}\n')).toEqual([])
  })

  it('leaves the entries kay never imported alone', () => {
    expect(found('--- server\nconst all = await cached(\'k\', \'5m\', async () => 1)\nconst f = files\n---\np {all}\n')).toEqual([])
    expect(found('---\nconst x = formatDate(new Date())\n---\np {x}\n')).toEqual([])
  })
})

describe('imports written for a name a `kay/*` entry exports', () => {
  it('writes an import into a module: into the entry\'s own, after the last specifier, else before the first import', () => {
    const apply = (source: string, wanted: Record<string, string[]>) => moduleImportEdits(source, new Map(Object.entries(wanted))).toSorted((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)

    expect(apply('import { s } from \'kay/server\'\n\nexport const a = [s, files]\n', { 'kay/server': ['files'] })).toBe('import { s, files } from \'kay/server\'\n\nexport const a = [s, files]\n')
    expect(apply('import {\n  s,\n} from "kay/server"\n', { 'kay/server': ['files', 'pages'] })).toBe('import {\n  s, files, pages,\n} from "kay/server"\n')
    expect(apply('import type { Row } from \'kay/server\'\nimport { x } from \'./x\'\n', { 'kay/server': ['files'], 'kay': ['signal'] })).toBe('import { files } from \'kay/server\'\nimport { signal } from \'kay\'\nimport type { Row } from \'kay/server\'\nimport { x } from \'./x\'\n')
    expect(apply('#!/usr/bin/env bun\n// header\nexport const a = 1\n', { kay: ['signal'] })).toBe('#!/usr/bin/env bun\nimport { signal } from \'kay\'\n\n// header\nexport const a = 1\n')
    expect(apply('import { x } from "./x";\n', { kay: ['signal'] })).toBe('import { signal } from "kay";\nimport { x } from "./x";\n')
  })

  async function project(files: Record<string, string>): Promise<string> {
    const root = await scratchDir('implicit-import-')
    const tsconfig = JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] })

    await Promise.all(Object.entries({ 'tsconfig.json': tsconfig, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    return root
  }

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
