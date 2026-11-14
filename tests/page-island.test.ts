import { describe, expect, it } from 'bun:test'
import { transformKay } from '../src/build/transform'
import { compileKay } from '../src/compiler'
import { DEPRECATED_LINTS } from '../src/compiler/deprecated-lints'
import { scratchDir } from './scratch'

const page = 'src/routes/p.kay'
const slice = (source: string, span: { start: number, end: number }) => source.slice(span.start, span.end)
const imported = { './clock': { clock: 'live' as const }, './prefs': { theme: 'persisted' as const } }
const warned = (source: string, filename = page, options = {}) => compileKay(source, filename, { check: true, page: true, importedSignals: imported, ...options }).diagnostics.filter(diagnostic => diagnostic.code === 'deprecated-page-island')

const handler = 'button(onClick={() => 1}) b\n'
const signal = '---\nimport { signal } from \'kay\'\nconst n = signal(0)\n---\np {n()}\n'
const live = '---\nimport { clock } from \'./clock\'\n---\np {clock()}\n'
const persisted = '---\nimport { theme } from \'./prefs\'\n---\np {theme()}\n'

describe('a plain page that is an island', () => {
  it('is a warning at the handler in the check, and still an island in every output', () => {
    for (const output of [undefined, 'html', 'dom'] as const) {
      const found = warned(handler, page, { output })

      expect(found.map(diagnostic => slice(handler, diagnostic))).toEqual(['onClick'])
      expect(found[0]!.message).toContain('line 1')
      expect(found[0]!.help).toContain('component')
      expect(found[0]!.checkOnly).toBe(true)
      expect(found[0]!.severity).toBe('warning')
      expect(found[0]!.fixes).toBeUndefined()
      expect(compileKay(handler, page, { output, page: true }).island).toBeDefined()
    }
  })

  it('is one for a bind, a ref and a `kay` value of the browser', () => {
    expect(warned('---\nlet text = \'\'\n---\ninput(bind:value={text})\n')).toHaveLength(1)
    expect(warned('---\nlet node\n---\ndiv(ref={node})\n')).toHaveLength(1)
    expect(warned(signal).map(diagnostic => slice(signal, diagnostic))).toEqual(['signal'])
  })

  it('is one for a live import and for a persisted one', () => {
    for (const [source, word] of [[live, 'clock'], [persisted, 'theme']] as const) {
      expect(warned(source).map(diagnostic => slice(source, diagnostic))).toEqual([word])
      expect(compileKay(source, page, { page: true, importedSignals: imported }).island).toBeDefined()
    }
  })

  it('names the first cause of the page once, not one warning per cause', () => {
    const source = `---\nimport { clock } from './clock'\n---\n${handler}`

    expect(warned(source)).toHaveLength(1)
  })

  it('compiles and builds as before, with no warning outside the check', async () => {
    const root = await scratchDir('page-island')

    expect(warned(handler, page, { check: false })).toEqual([])
    expect(() => transformKay(handler, `${root}/src/routes/p.kay`, { target: 'ssr', root })).not.toThrow()
  })

  it('has a lint that is deprecated since 1.105, with no safe fix', () => {
    expect(DEPRECATED_LINTS['deprecated-page-island'].since).toBe('1.105')
  })
})

describe('what is not reported', () => {
  it('reads nothing from a page with no handler, no signal and no live import', () => {
    expect(warned('---\nconst a = 1\n---\np {a}\n')).toEqual([])
    expect(warned('---\nimport Counter from \'../components/counter.kay\'\n---\nCounter\n')).toEqual([])
  })

  it('leaves a component with the same handler alone', () => {
    expect(warned(handler, 'src/components/c.kay', { page: false })).toEqual([])
    expect(compileKay(handler, 'src/components/c.kay', { page: false }).island).toBeDefined()
    expect(compileKay(live, 'src/components/c.kay', { importedSignals: imported }).island).toBeDefined()
  })

  it('leaves a page with a server fence, a layout and a special page alone', () => {
    expect(warned(`--- server\nconst n = 1\n---\n${handler}`)).toEqual([])

    for (const filename of ['src/routes/_layout.kay', 'src/routes/_404.kay'])
      expect(warned(handler, filename)).toEqual([])
  })
})

describe('a name the template reads that only the server fence imports', () => {
  const route = 'src/routes/index.kay'
  const sized = (source: string, filename = route, options = {}) => compileKay(source, filename, { check: true, page: true, ...options }).diagnostics.filter(diagnostic => diagnostic.code === 'server-import-in-island')
  const server = '--- server\nimport { formatFileSize } from \'@kaynooo/utils/format\'\nconst shares = [{ id: 1, size: 5 }]\n'
  const script = '--- script\nimport ConfirmDelete from \'@kayjs/ui/confirm-delete.kay\'\n---\n'
  const template = 'for share of shares key={share.id}\n  span {formatFileSize(share.size)}\n  ConfirmDelete(label="Delete" onConfirm={async () => 1})\n'
  const hydrating = `${server}${script}${template}`

  it('is reported at the read in a page that hydrates, with the import as the offered fix', () => {
    const [found, ...more] = sized(hydrating)
    const at = hydrating.indexOf('import ConfirmDelete')

    expect(more).toEqual([])
    expect(slice(hydrating, found!)).toBe('formatFileSize')
    expect(found!.checkOnly).toBe(true)
    expect(found!.fixes?.[0]?.safe).toBeUndefined()
    expect(found!.fixes![0]!.edits).toEqual([{ start: at, end: at, text: 'import { formatFileSize } from \'@kaynooo/utils/format\'\n' }])
  })

  it('keeps the page an island, since a handler makes it one, and refuses what the browser would throw on', () => {
    const compiled = compileKay(hydrating, route, { page: true, output: 'dom', includeServer: false })

    expect(compiled.island).toBeDefined()
    expect(compiled.tsx).not.toContain('import { formatFileSize }')
    expect(compileKay(hydrating, route, { page: true, check: true }).diagnostics.map(diagnostic => diagnostic.code)).not.toContain('deprecated-page-island')
  })

  it('says nothing once the script fence imports it too, for a page that does not hydrate, or for a type', () => {
    expect(sized(hydrating.replace(script, '--- script\nimport { formatFileSize } from \'@kaynooo/utils/format\'\nimport ConfirmDelete from \'@kayjs/ui/confirm-delete.kay\'\n---\n'))).toEqual([])
    expect(sized(`${server}---\n---\nfor share of shares key={share.id}\n  span {formatFileSize(share.size)}\n`)).toEqual([])
    expect(sized(`--- server\nimport type { Size } from './size'\nconst n: Size = 1\n${script}button(onClick={() => 1}) {n}\n`)).toEqual([])
  })

  it('covers a layout that hydrates, which a handler makes an island', () => {
    expect(sized(hydrating, 'src/routes/_layout.kay', { page: undefined })).toHaveLength(1)
  })
})
