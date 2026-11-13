import type { Diagnostic } from '../src/compiler/ast'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { isPageFile, mountedPageDirs } from '../src/build/page-dirs'
import { analyzeKayCached, transformKay } from '../src/build/transform'
import { compileShadow } from '../src/check/shadow'
import { browserRole, compileKay, rendersAsIsland } from '../src/compiler'
import { parseKay } from '../src/compiler/parser'
import { scratchDir } from './scratch'

const part = 'src/components/part.kay'
const slice = (source: string, span: { start: number, end: number }) => source.slice(span.start, span.end)
const pins = (source: string, filename = part, options = {}) => compileKay(source, filename, { check: true, ...options }).diagnostics.filter(diagnostic => diagnostic.code === 'static-pin')
const apply = (source: string, diagnostic: Diagnostic) => diagnostic.fixes![0]!.edits.toSorted((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)

const handler = 'button(onClick={() => 1}) b\n'
const passing = '---\nimport Picker from \'./picker.kay\'\nfunction shout() {}\n---\nPicker(format={shout})\n'

describe('the island and static fence lines', () => {
  it('reads `--- island` and `--- static` as the script fence, generic ones included', () => {
    const island = parseKay('--- island\nconst a = 1\n---\np {a}\n')
    const pinned = parseKay('--- static <T extends string>\nconst { a } = props<{ a: T }>()\n---\np {a}\n')

    expect(island.pin).toMatchObject({ kind: 'island' })
    expect(slice(island.source, island.pin!)).toBe('island')
    expect(slice(island.source, island.script!)).toBe('const a = 1\n')
    expect(pinned.pin).toMatchObject({ kind: 'static' })
    expect(slice(pinned.source, pinned.typeParameters!)).toBe('T extends string')
    expect([...island.diagnostics, ...pinned.diagnostics]).toEqual([])
    expect(parseKay('---\nconst a = 1\n---\np\n').pin).toBeUndefined()
  })

  it('takes one script fence, and not a pin written inside a template literal', () => {
    const twice = parseKay('--- island\nconst a = 1\n--- static\nconst b = 2\n---\np\n')
    const literal = parseKay('---\nconst md = `\n--- island\n`\n---\np\n')
    const server = parseKay('--- server\nconst a = 1\n--- island\nconst b = 2\n---\np\n')

    expect(twice.diagnostics.map(diagnostic => diagnostic.message)).toEqual(['A file has one script fence'])
    expect(literal.pin).toBeUndefined()
    expect(literal.diagnostics).toEqual([])
    expect(server.pin).toMatchObject({ kind: 'island' })
    expect(parseKay('--- islands\nconst a = 1\n---\np\n').diagnostics.map(diagnostic => diagnostic.message)).toEqual(['Unknown fence `--- islands`'])
  })
})

describe('--- island', () => {
  const source = '--- island\nconst label = \'a\'\n---\np {label}\n'

  it('makes a component with nothing interactive an island, on the server and in the browser', () => {
    for (const output of [undefined, 'html', 'dom'] as const) {
      const compiled = compileKay(source, part, { output })

      expect(compiled.island).toBeDefined()
      expect(compiled.diagnostics).toEqual([])
    }

    expect(compileKay('---\nconst label = \'a\'\n---\np {label}\n', part).island).toBeUndefined()
    expect(rendersAsIsland(source)).toBe(true)
    expect(browserRole(source, part)).toBe('island')
  })

  it('is the cause the editor and the build report', () => {
    expect(compileKay(source, part).cause).toMatchObject({ kind: 'island', name: '--- island', line: 1 })
    expect(slice(source, compileKay(source, part).cause!.span)).toBe('island')
    expect(compileKay(source, part).why).toBe('a `--- island` fence')
  })

  it('makes a component that passes a function an island, which the same component without it is not', () => {
    const pinned = passing.replace('---\n', '--- island\n')

    expect(compileKay(pinned, part).island).toBeDefined()
    expect(compileKay(passing, part).island).toBeUndefined()
    expect(compileKay(passing, part, { output: 'html', hydratable: true }).tsx).not.toContain('KayPromote')
  })

  it('stays static in a page, a layout or a special page, and says so', () => {
    for (const filename of ['src/routes/_layout.kay', 'src/routes/_404.kay']) {
      const compiled = compileKay(source, filename, { check: true })

      expect(compiled.island).toBeUndefined()
      expect(compiled.diagnostics.filter(diagnostic => diagnostic.code === 'island-marker').map(diagnostic => slice(source, diagnostic))).toEqual(['island'])
    }

    expect(compileKay('--- server\nconst a = 1\n--- island\nconst b = 2\n---\np {a}\n', 'src/routes/index.kay', { check: true }).island).toBeUndefined()
  })

  it('does not say anything of a component that is an island already', () => {
    const redundant = `--- island\n${'const a = 1\n---\n'}${handler}`

    expect(compileKay(redundant, part, { check: true }).diagnostics).toEqual([])
  })
})

describe('--- static', () => {
  it('leaves a component with nothing to make it an island as it is', () => {
    const source = '--- static\nimport { uid } from \'kay\'\nconst id = uid()\n---\np(id={id}) a\n'
    const compiled = compileKay(source, part, { check: true })

    expect(compiled.island).toBeUndefined()
    expect(compiled.diagnostics).toEqual([])
    expect(compileKay('--- static\nconst a = 1\n---\np {a}\n', 'src/routes/_layout.kay', { check: true }).diagnostics).toEqual([])
  })

  it('is an error at the handler that makes it an island, in every output', () => {
    const source = `--- static\nconst a = 1\n---\ninput(onInput={() => a})\n`

    for (const output of [undefined, 'html', 'dom'] as const) {
      const found = pins(source, part, { output })

      expect(found.map(diagnostic => slice(source, diagnostic))).toEqual(['onInput'])
      expect(found[0]!.severity).toBeUndefined()
      expect(found[0]!.message).toContain('`onInput`, line 4')
      expect(found[0]!.checkOnly).toBeUndefined()
    }
  })

  it('is an error at a `kay` value of the browser, a bind and a ref', () => {
    const value = '--- static\nimport { signal } from \'kay\'\nconst n = signal(0)\n---\np {n()}\n'

    expect(pins(value).map(diagnostic => slice(value, diagnostic))).toEqual(['signal'])
    expect(pins('--- static\nlet text = \'\'\n---\ninput(bind:value={text})\n').map(diagnostic => diagnostic.message)).toHaveLength(1)
    expect(pins('--- static\nlet node\n---\ndiv(ref={node})\n')).toHaveLength(1)
  })

  it('is no island, so what it passes an island that cannot be sent is the `island-prop` error of the types', () => {
    const source = passing.replace('---\n', '--- static\n')

    expect(pins(source)).toEqual([])
    expect(browserRole(source, part)).toBeUndefined()
    expect(compileKay(source, part, { output: 'html', hydratable: true }).island).toBeUndefined()
  })

  it('is an error for a live value, and not for a route file, which is never an island', () => {
    const live = '--- static\nimport { clock } from \'./clock\'\n---\np {clock()}\n'
    const imported = { './clock': { clock: 'live' as const } }

    expect(pins(live, part, { importedSignals: imported })).toHaveLength(1)
    expect(pins(live, 'src/routes/_layout.kay', { importedSignals: imported })).toEqual([])
    expect(pins('--- static\n---\nbutton(onClick={() => 1}) b\n', 'src/routes/_layout.kay')).toEqual([])
  })

  it('counts the line in the file the author wrote, not in the markdown it expands to', () => {
    const source = '--- static\nconst a = 1\n---\nmain\n  markdown\n    # Hello\n\n    text\n  button(onClick={() => a}) +\n'
    const [found] = pins(source)

    expect(slice(source, found!)).toBe('onClick')
    expect(found!.message).toContain('line 9')
  })

  it('does not report a component that is static in the browser only through a nested island', () => {
    const source = '--- static\nimport Counter from \'./counter.kay\'\n---\nCounter(start={1})\ndiv\n  Counter(start={2})\n'

    expect(pins(source)).toEqual([])
    expect(compileKay(source, part, { check: true }).island).toBeUndefined()
  })

  it('is not set by text that only looks like a fence', () => {
    const literal = '---\nconst md = `\n--- static\n`\n---\nbutton(onClick={() => md}) b\n'

    expect(pins(literal)).toEqual([])
    expect(compileKay(literal, part).island).toBeDefined()
  })
})

describe('the old comments', () => {
  it('pin nothing since 1.95: a `// kay-island` or `// kay-static` comment is a comment', () => {
    for (const word of ['island', 'static']) {
      const source = `---\n// kay-${word}\nconst a = 1\n---\n${handler}`
      const compiled = compileKay(source, part, { check: true })

      expect(compiled.diagnostics.filter(diagnostic => diagnostic.code === 'island-comment' || diagnostic.code === 'static-pin')).toEqual([])
      expect(compiled.island).toBeDefined()
    }

    expect(browserRole(`---\n// kay-island\n${passing.slice(4)}`, part)).toBeUndefined()
  })
})

describe('island-marker', () => {
  it('is only a pin on a route file now', () => {
    const marker = (source: string, filename = part) => compileKay(source, filename, { check: true }).diagnostics.filter(diagnostic => diagnostic.code === 'island-marker')

    expect(marker('---\n// kay-island\nconst a = 1\n---\np {a}\n', 'src/routes/_layout.kay')).toEqual([])
    expect(marker('--- island\nconst a = 1\n---\np {a}\n', 'src/routes/_layout.kay')).toHaveLength(1)
    expect(marker('--- static\nconst a = 1\n---\np {a}\n', 'src/routes/_layout.kay')).toEqual([])
  })
})

describe('a page of the routes directory', () => {
  const route = 'src/routes/p.kay'
  const codes = (source: string, filename: string, page: boolean | undefined) => compileKay(source, filename, { check: true, page }).diagnostics.map(diagnostic => diagnostic.code).filter(code => code === 'client-route-fence' || code === 'island-marker')
  const server = '--- server\nconst b = 1\n'

  it('is refused `--- client` and `--- island` with a server fence or without', () => {
    for (const fence of ['client', 'island']) {
      const code = fence === 'client' ? 'client-route-fence' : 'island-marker'

      expect(codes(`--- ${fence}\nconst a = 1\n---\np {a}\n`, route, true)).toEqual([code])
      expect(codes(`${server}--- ${fence}\nconst a = 1\n---\np {a}\n`, route, true)).toEqual([code])
      expect(codes(`${server}--- ${fence}\nconst a = 1\n---\np {a}\n`, route, undefined)).toEqual([code])
    }
  })

  it('is refused the same in a layout and a special page', () => {
    expect(codes('--- client\nconst a = 1\n---\np {a}\n', 'src/routes/_layout.kay', true)).toEqual(['client-route-fence'])
    expect(codes('--- island\nconst a = 1\n---\np {a}\n', 'src/routes/_404.kay', true)).toEqual(['island-marker'])
  })

  it('leaves a component and a page with no such fence alone', () => {
    expect(codes('--- client\nconst a = 1\n---\np {a}\n', 'src/components/c.kay', false)).toEqual([])
    expect(codes('--- island\nconst a = 1\n---\np {a}\n', 'src/components/c.kay', undefined)).toEqual([])
    expect(codes('--- static\nconst a = 1\n---\np {a}\n', route, true)).toEqual([])
    expect(codes('---\nconst a = 1\n---\np {a}\n', route, true)).toEqual([])
  })
})

describe('a plain page', () => {
  const pinned = '--- island\nconst a = 1\n---\np {a}\n'
  const live = '---\nimport { visitors } from \'./live\'\n---\np {visitors()}\n'
  const signals = { './live': { visitors: 'live' as const } }

  it('is no island by its pin, and a partial or a component is', () => {
    expect(compileKay(pinned, 'src/routes/p.kay', { page: true }).island).toBeUndefined()
    expect(compileKay(pinned, 'src/routes/_partial.kay').island).toBeDefined()
    expect(compileKay(pinned, 'src/components/c.kay', { page: false }).island).toBeDefined()
    expect(rendersAsIsland(pinned, undefined, true)).toBe(false)
    expect(rendersAsIsland(pinned)).toBe(true)
    expect(browserRole(pinned, 'src/routes/p.kay', undefined, true)).toBeUndefined()
    expect(browserRole(pinned, 'src/routes/_partial.kay')).toBe('island')
  })

  it('is still an island by a live import, and by a package that is client-only', () => {
    expect(compileKay(live, 'src/routes/p.kay', { page: true, importedSignals: signals }).island).toBeDefined()
    expect(compileKay('p x\n', 'src/routes/p.kay', { page: true, clientOnly: true }).island).toBeDefined()
  })

  it('gets one answer from the build, the analysis, the shadow and the predicate', async () => {
    const root = await scratchDir('page-role')
    const routesDir = join(root, 'src/routes')
    const cache = join(root, '.kay/cache')
    const roleOf = async (name: string) => {
      const file = join(routesDir, name)
      const page = isPageFile(file, [routesDir])
      const built = (/KayIsland\(/).test(transformKay(pinned, file, { target: 'ssr', root, hydratable: true }))
      const analysis = await analyzeKayCached(pinned, file, root, cache, true, undefined, false, page)
      const shadow = compileShadow(root, file, pinned, { routesDir, mounts: [] })

      return { page, built, analysed: analysis.island !== undefined, marker: [analysis.diagnostics, shadow.diagnostics].map(found => found.some(diagnostic => diagnostic.code === 'island-marker')) }
    }

    expect(await roleOf('p.kay')).toEqual({ page: true, built: false, analysed: false, marker: [true, true] })
    expect(await roleOf('_partial.kay')).toEqual({ page: false, built: true, analysed: true, marker: [false, false] })
  })
})

describe('isPageFile', () => {
  it('takes a routable file of the routes directory or of a mount, and no `_` file or outer folder', async () => {
    const root = await scratchDir('page-file')
    const routes = join(root, 'src/routes')
    const mounted = join(root, 'node_modules/ext/routes')
    const outer = join(root, 'node_modules/ext/outer')
    const dirs = mountedPageDirs(routes, [{ dir: mounted, prefix: '' }, { dir: outer, prefix: '', outer: join(root, 'x') }])

    expect(dirs).toEqual([routes, mounted])
    expect(isPageFile(join(routes, 'p.kay'), dirs)).toBe(true)
    expect(isPageFile(join(mounted, 'sub/p.kay'), dirs)).toBe(true)
    expect(isPageFile(join(routes, '_partial.kay'), dirs)).toBe(false)
    expect(isPageFile(join(routes, '_layout.kay'), dirs)).toBe(false)
    expect(isPageFile(join(outer, 'c.kay'), dirs)).toBe(false)
    expect(isPageFile(join(root, 'src/components/c.kay'), dirs)).toBe(false)
  })

  it('follows a linked routes directory', async () => {
    const root = await scratchDir('page-link')

    await mkdir(join(root, 'real'), { recursive: true })
    await symlink(join(root, 'real'), join(root, 'linked'))
    await Bun.write(join(root, 'real/p.kay'), 'p x\n')

    expect(isPageFile(join(root, 'real/p.kay'), [join(root, 'linked')])).toBe(true)
  })

  it('leaves a recipe in a partial to the component it is, as the check reads it', () => {
    const recipe = '---\nimport { recipe } from \'kay\'\nconst look = recipe({ variants: { tone: { a: \'\' } } })\n---\np(class={look()}) x\n'
    const root = '/tmp/nokay'
    const build = (file: string) => transformKay(recipe, join(root, file), { target: 'ssr', root })

    expect(() => build('src/routes/_partial.kay')).not.toThrow()
    expect(() => build('src/routes/p.kay')).toThrow()
  })
})

describe('beside the pin', () => {
  it('writes the browser-only fix over the pin label, not beside it', () => {
    for (const word of ['island', 'static']) {
      const source = `--- ${word}\nconst w = window.innerWidth\n---\np {w}\n`
      const fix = compileKay(source, part, { check: true }).diagnostics.flatMap(diagnostic => diagnostic.fixes ?? []).find(candidate => candidate.title.includes('--- client'))

      expect(fix).toBeDefined()
      expect(apply(source, { fixes: [fix!] } as Diagnostic)).toBe('--- client\nconst w = window.innerWidth\n---\np {w}\n')
    }
  })

  it('does not error on a static pin that hands a plain child a function', () => {
    expect(pins('--- static\nimport Child from \'./plain.kay\'\nfunction pick() {}\n---\nChild(format={pick})\n')).toEqual([])
  })
})
