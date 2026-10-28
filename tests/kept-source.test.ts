import type { CallExpression } from '@babel/types'
import { utimesSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { classIndex } from '../src/build/class-sources'
import { readSource } from '../src/build/files'
import { inParseScope, SourceParses } from '../src/build/source-parses'
import { readKeptSource } from '../src/server/kept-source'
import { keptScan } from '../src/server/pure-page'
import { kayBuild } from './check-helper'
import { scratchDir } from './scratch'

const readOf = (file: string, source: string) => readKeptSource(file, source).read?.what
const ctxOf = (file: string, source: string) => readKeptSource(file, source).ctx

describe('what a kept page\'s scan reads of a source', () => {
  it('finds a read of the request or the moment in code, and none in a comment, a string, a type or a property name', () => {
    expect(readOf('a.ts', 'export const now = Date.now()\n')).toBe('Date')
    expect(readOf('a.ts', 'export const roll = Math.random()\n')).toBe('Math')
    expect(readOf('a.ts', 'export const math = Math\n')).toBe('Math')
    expect(readOf('a.ts', 'export const load = () => import(\'./b\')\n')).toBe('import(')
    expect(readOf('a.ts', 'export const here = import.meta.dir\n')).toBe('import.meta')
    expect(readOf('a.kay', '--- server\nexport const page = { query: s.Object({}) }\n---\np x\n')).toBe('query:')
    expect(readOf('a.kay', 'p {new Date().getFullYear()}\n')).toBe('Date')
    expect(readOf('a.kay', 'markdown\n  Built {process.env.SHA}\n')).toBe('process')
    expect(readOf('a.kay', 'snippet row(at = Date.now())\n  p {at}\n')).toBe('Date')

    expect(readOf('a.ts', 'export const sha = global.process.env.SHA\n')).toBe('global')
    expect(readOf('a.ts', 'export const id = self.crypto.randomUUID()\n')).toBe('self')
    expect(readOf('a.ts', 'export const roll = window[\'Math\'].random()\n')).toBe('window')
    expect(readOf('a.ts', 'export const now = new Function(\'return Date.now()\')()\n')).toBe('Function')
    expect(readOf('a.kay', 'for { at = Date.now() } of rows\n  p {at}\n')).toBe('Date')
    expect(readOf('a.kay', 'for [row, at = Date.now()] of rows\n  p {row}{at}\n')).toBe('Date')

    expect(readOf('a.ts', '// fetch the Date from process\nexport const floor = Math.floor(1.5)\n')).toBeUndefined()
    expect(readOf('a.ts', 'export class Clock {\n  #fetch = 1\n  #Date() {\n    return this.#fetch\n  }\n}\n')).toBeUndefined()
    expect(readOf('a.kay', 'button(onclick={() => window.scrollTo(0, 0)}) Top\n')).toBeUndefined()
    expect(readOf('a.ts', 'export const text = \'fetch a Date from process\'\nexport const label = { fetch: 1 }.fetch\n')).toBeUndefined()
    expect(readOf('a.ts', 'export function since(at: Date, format: Intl.NumberFormat): string {\n  return format.format(at.getTime())\n}\n')).toBeUndefined()
    expect(readOf('a.kay', 'p The Date is fetched by process\n')).toBeUndefined()
    expect(readOf('a.kay', '---\nconst { at } = props<{ at: Date }>()\n---\np {at.getTime()}\n')).toBeUndefined()
  })

  it('judges a member written as a string by the name it holds, for a global and for ctx', () => {
    expect(readOf('a.kay', 'button(onclick={() => window[\'scrollTo\'](0, 0)}) Top\n')).toBeUndefined()
    expect(readOf('a.ts', 'export const top = () => self[`scrollTo`](0, 0)\nexport const floor = Math[\'floor\'](1.5)\n')).toBeUndefined()
    expect(readOf('a.ts', 'export const roll = Math[\'random\']()\n')).toBe('Math')
    expect(readOf('a.ts', 'export const sha = window[\'process\'].env.SHA\n')).toBe('window')
    expect(readOf('a.ts', 'export const at = (key: string) => window[key]\n')).toBe('window')
    expect(ctxOf('a.kay', '--- server\nconst here = ctx[\'url\'][\'pathname\']\nconst id = ctx[\'params\'].id\nconst { \'params\': all } = ctx\n---\np {here}{id}{all}\n')).toBeUndefined()
    expect(readKeptSource('a.kay', '--- server\nconst here = ctx[\'url\'].pathname\n---\np {here}\n').pathname).toBe(true)
    expect(ctxOf('a.kay', 'p {ctx[\'cookies\'].get(\'a\')}\n')).toBe(3)
  })

  it('reads no global a name the file binds shadows, in the scope it binds it', () => {
    expect(readOf('a.ts', 'export function at(Date: number) {\n  return Date\n}\n')).toBeUndefined()
    expect(readOf('a.ts', 'import { fetch } from \'./api\'\nexport const rows = () => fetch(\'/rows\')\n')).toBeUndefined()
    expect(readOf('a.ts', 'const process = { env: {} }\nexport const sha = process.env\n')).toBeUndefined()
    expect(readOf('a.ts', 'export function first() {\n  if (true) {\n    var crypto = 1\n  }\n  return crypto\n}\n')).toBeUndefined()
    expect(readOf('a.ts', 'export const each = (rows: number[]) => rows.map(({ Math }) => Math)\ntry {}\ncatch (window) {\n  window.Math\n}\n')).toBeUndefined()
    expect(readOf('a.kay', '---\nimport { performance } from \'./perf\'\n---\np {performance.score}\n')).toBeUndefined()

    expect(readOf('a.ts', 'export function at(Date: number) {\n  return Date\n}\nexport const now = Date.now()\n')).toBe('Date')
    expect(readOf('a.ts', 'export function at() {\n  {\n    const Date = 1\n  }\n  return Date.now()\n}\n')).toBe('Date')
    expect(readOf('a.ts', 'import type { Bun } from \'./types\'\nexport const file = Bun.file(\'a\')\n')).toBe('Bun')
    expect(readOf('a.ts', 'declare const fetch: () => void\nexport const rows = fetch()\n')).toBe('fetch')
    expect(readOf('a.ts', 'namespace Clock {\n  var Date = 1\n}\nexport const now = Date.now()\n')).toBe('Date')
    expect(readOf('a.ts', 'export const at = (f = function Date() {}) => Date.now()\n')).toBe('Date')
  })

  it('reads nothing in the value of `lastmod`, which the sitemap reads and no render does', () => {
    const source = '--- server\nexport const page = { lastmod: new Date() }\n---\np x\n'
    const value = source.indexOf('new Date()')

    expect(readKeptSource('a.kay', source, { start: value, end: value + 'new Date()'.length }).read).toBeUndefined()
  })

  it('follows ctx only through its path, and a property or a parameter named ctx is not it', () => {
    expect(ctxOf('a.kay', '--- server\nconst here = ctx.url.pathname\nconst id = ctx?.params?.id\nconst { url: { pathname }, params } = ctx\n---\np {here}{id}{pathname}\n')).toBeUndefined()
    expect(readKeptSource('a.kay', '--- server\nconst here = ctx.url.pathname\n---\np {here}\n').pathname).toBe(true)
    expect(ctxOf('a.ts', 'export const draw = (canvas: HTMLCanvasElement) => canvas.getContext(\'2d\')\nexport const widget = { ctx: 1 }.ctx\n')).toBeUndefined()
    expect(ctxOf('a.kay', '--- server\nexport const save = action(s.Object({}), (input, ctx) => ctx.params.id)\n---\np x\n')).toBeUndefined()

    for (const source of ['p {ctx.url.search}', 'p {ctx.cookies.get(\'a\')}', 'p {here(ctx)}', 'p {ctx.url.pathname = \'/\'}', 'p {ctx[\'url\']}', 'p {(ctx as any).url.pathname}'])
      expect(ctxOf('a.kay', `${source}\n`), source).toBe(source.indexOf('ctx'))

    expect(ctxOf('a.kay', '--- server\nconst { url, params } = ctx\n---\np {url.search}\n')).toBe('--- server\nconst { url, params } = '.length)
    expect(ctxOf('a.kay', '--- server\nconst { params, ...rest } = ctx\n---\np {rest}\n')).toBe('--- server\nconst { params, ...rest } = '.length)
  })

  it('lists the imports and re-exports of code, and none written in a string or the template\'s text', () => {
    const { imports } = readKeptSource('a.kay', '--- server\nimport { persisted as keep, signal } from \'kay\'\nimport type { Signal } from \'kay\'\nimport { type Bindable } from \'kay\'\nimport Card from \'./card.kay\'\nimport * as all from \'./all\'\nimport \'./effect\'\nexport { a as b } from \'./a\'\nexport * from \'./b\'\nconst sample = \'import { x } from "pkg"\'\n---\npre import { y } from \'other\'\n')

    expect(imports.map(({ specifier, names, withDefault, typesOnly }) => ({ specifier, names: names?.map(({ text }) => text), withDefault, typesOnly }))).toEqual([
      { specifier: 'kay', names: ['persisted as keep', 'signal'], withDefault: false, typesOnly: false },
      { specifier: 'kay', names: [], withDefault: false, typesOnly: true },
      { specifier: './card.kay', names: [], withDefault: true, typesOnly: false },
      { specifier: './all', names: undefined, withDefault: false, typesOnly: false },
      { specifier: './effect', names: undefined, withDefault: false, typesOnly: false },
      { specifier: './a', names: ['a as b'], withDefault: false, typesOnly: false },
      { specifier: './b', names: undefined, withDefault: false, typesOnly: false },
    ])
    expect(readKeptSource('a.ts', 'export { "a-b" as c } from \'./a\'\n').imports[0]?.names?.map(({ own }) => own)).toEqual(['a-b'])
  })

  it('records each use of a name with the arguments of a call to it', () => {
    const { uses } = readKeptSource('a.kay', '---\nconst a = persisted<(string | number)[]>(\'a\', [], { storage: \'local\' })\nconst make = persisted\n---\np {a()}\n')

    expect(uses.get('persisted')?.map(args => args?.length)).toEqual([3, undefined])
  })

  it('says where a source does not parse', () => {
    expect(readKeptSource('a.ts', 'export const a = (\n').unparsed).toBeNumber()
    expect(readKeptSource('a.kay', 'p {a +}\n').unparsed).toBeGreaterThanOrEqual(3)
  })
})

describe('a page the scan reads from its parse', () => {
  const roots: string[] = []

  afterAll(async () => {
    await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
  })

  it('is kept when it takes only types from kay, and not when a file it reads does not parse', async () => {
    const root = await scratchDir('kept-source-')
    const files = {
      'src/routes/types.kay': '---\nimport { type Signal } from \'kay\'\n\nconst { open } = props<{ open: Signal<boolean> }>()\n---\np {open()}\n',
      'src/routes/broken.kay': '---\nimport { label } from \'../label\'\n---\np {label}\n',
      'src/label.ts': 'export const label = (\n',
    }

    roots.push(root)
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const at = async (name: string) => (await keptScan({ file: join(root, `src/routes/${name}.kay`), layouts: [] })).stop

    expect(await at('types')).toBeUndefined()
    expect(await at('broken')).toMatchObject({ file: join(root, 'src/label.ts'), why: 'does not parse, so nothing shows what it reads' })
  })

  it('takes up in a build the parse the class index made of a script, a fence and a template expression, and keeps none of its own', async () => {
    const root = await scratchDir('kept-source-')
    const script = join(root, 'tone.ts')
    const kay = join(root, 'card.kay')
    const alone = join(root, 'alone.ts')
    const setsTone = 'const tone = pick(\'a\')\nexport const paint = (el: HTMLElement) => {\n  el.className = tone\n}\n'

    roots.push(root)
    await Bun.write(script, setsTone)
    await Bun.write(kay, '---\nconst tone = pick(\'a\')\n---\nmarkdown\n  Some *text*\np(class={shade(\'b\')}) {tone}\n')
    await Bun.write(alone, setsTone)

    // A file written this recently is read anew at each call, its parses with it.
    for (const file of [script, kay, alone])
      utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))

    const uses = (file: string) => readKeptSource(file, readSource(file).text).uses
    const indexed = (file: string) => classIndex(readSource(file).text, file)
    const argument = (node: unknown) => (node as CallExpression).arguments[0]

    await inParseScope(async () => {
      const scriptIndex = indexed(script)
      const kayIndex = indexed(kay)
      const kayUses = uses(kay)

      expect(uses(script).get('pick')?.[0]?.[0]).toBe(argument(scriptIndex.values.get('tone')![0]))
      expect(kayUses.get('pick')?.[0]?.[0]).toBe(argument(kayIndex.values.get('tone')![0]))
      expect(kayUses.get('shade')?.[0]?.[0]).toBe(argument(kayIndex.setters[0]!.values[0]!.node))
      // The setter after the markdown block is told at its own line.
      expect(kayIndex.setters.map(({ line, how }) => ({ line, how }))).toEqual([{ line: 6, how: 'class attribute' }])

      const kept = uses(alone).get('pick')?.[0]?.[0]

      expect(argument(indexed(alone).values.get('tone')![0])).not.toBe(kept)
      expect(uses(script).get('pick')?.[0]?.[0]).not.toBe(argument(scriptIndex.values.get('tone')![0]))
    })

    // Outside a build nothing is kept.
    const fresh = await scratchDir('kept-source-')
    const outside = join(fresh, 'tone.ts')

    roots.push(fresh)
    await Bun.write(outside, setsTone)
    utimesSync(outside, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    expect(uses(outside).get('pick')?.[0]?.[0]).not.toBe(argument(indexed(outside).values.get('tone')![0]))
  })

  it('takes up in `kay build` the parses the class index made of a page', async () => {
    const root = await scratchDir('kept-source-')
    const files = {
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
      'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false })\n',
      'src/routes/index.kay': '---\nconst tone = [\'mt-1\', \'mt-2\'][0]\n---\np(class={tone}) Hi\n',
    }

    roots.push(root)
    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))
    utimesSync(join(root, 'src/routes/index.kay'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))

    // What the kept-page scan found kept for it, a parse for each it took up.
    const taken: string[] = []
    const parses = SourceParses.prototype as unknown as { taken: (kept: Map<string, unknown>, key: string, text: string) => unknown }
    const take = parses.taken
    const spy = spyOn(parses, 'taken').mockImplementation(function (this: unknown, kept, key, text) {
      const known = take.call(this, kept, key, text)

      if (known !== undefined)
        taken.push(key)

      return known
    })

    try {
      expect((await kayBuild([root, '--no-check'])).code).toBe(0)
    }
    finally {
      spy.mockRestore()
    }

    expect(taken).toContain('kay')
    expect(taken.some(key => key.startsWith('program '))).toBe(true)
    expect(taken.some(key => key.startsWith('expression '))).toBe(true)
  }, 120_000)
})
