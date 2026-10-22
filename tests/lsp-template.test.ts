import { describe, expect, it } from 'bun:test'
import { componentInterface } from '../src/lsp/component-props'
import { documentSymbols, foldingRanges } from '../src/lsp/outline'
import { importEdits } from '../src/lsp/renames'
import { templateContext } from '../src/lsp/template-completion'

// The context at the `|` of a source.
function at(marked: string, templateStart = 0) {
  const offset = marked.indexOf('|')
  const source = marked.slice(0, offset) + marked.slice(offset + 1)
  const context = templateContext(source, offset, templateStart)

  return context && { ...context.wanted, replaced: source.slice(context.replace.start, context.replace.end) }
}

describe('template completion contexts', () => {
  it('finds attribute names inside parentheses, leaving out those written', () => {
    expect(at('a(hr|)')).toMatchObject({ kind: 'attribute', tag: 'a', replaced: 'hr' })
    expect(at('Card.wide#top(title="x" |)')).toMatchObject({ kind: 'attribute', tag: 'Card', taken: new Set(['title']) })
    expect(at('a(href=|)')).toBeUndefined()
    expect(at('a(href={x|})')).toBeUndefined()
    expect(at('li: a(|)')).toMatchObject({ kind: 'attribute', tag: 'a' })
    expect(at('p(onClick={() => go(|)})')).toBeUndefined()
  })

  it('finds block keywords and elements at a line start, and blocks after @', () => {
    expect(at('ul\n  fo|')).toMatchObject({ kind: 'line', replaced: 'fo' })
    expect(at('Card\n  @ac|')).toMatchObject({ kind: 'line', slotOf: 'Card', replaced: 'ac' })
    expect(at('p | te|')).toBeUndefined()
    expect(at('p hello |')).toBeUndefined()
  })

  it('finds route paths, message keys and lint names', () => {
    expect(at('a(href="/to|")')).toMatchObject({ kind: 'path', replaced: '/to' })
    expect(at('a(href="https://x|")')).toBeUndefined()
    expect(at('---\nnavigate(\'/|\')\n---\np x', 0)).toMatchObject({ kind: 'path' })
    expect(at('p {t(\'nav.ab|\')}')).toMatchObject({ kind: 'message', replaced: 'nav.ab' })
    expect(at('// kay-allow unread-name, un|')).toMatchObject({ kind: 'lint', replaced: 'un' })
  })

  it('offers no element or attribute name inside a fence', () => {
    expect(at('---\nconst x = 1\nfo|\n---\np x', 22)).toBeUndefined()
  })
})

describe('component interface', () => {
  it('reads props from the type, a named type and the destructuring, and the blocks it renders', () => {
    const named = '---\ninterface Props {\n  title: string\n  tone?: \'a\' | \'b\'\n  onPick: (id: number) => void\n}\nconst { title, extra = 1 } = props<Props>()\n---\nslot actions\nslot\n'

    expect(componentInterface(named)).toEqual({ props: [{ name: 'title', optional: false }, { name: 'tone', optional: true }, { name: 'onPick', optional: false }, { name: 'extra', optional: true }], blocks: ['actions'] })
    expect(componentInterface('p x')).toEqual({ props: [], blocks: [] })
  })
})

describe('outline and folds', () => {
  const source = '---\nimport { signal } from \'kay\'\nconst { a } = props<{ a: string }>()\nconst n = signal(0)\n---\nif a\n  p x\nelse\n  p#hero y\nCard\n  @row(item)\n    li {item}\n'

  it('names fences, their declarations and the template blocks', () => {
    const names = (symbols: ReturnType<typeof documentSymbols>): unknown => symbols.map(symbol => symbol.children ? [symbol.name, names(symbol.children)] : symbol.name)

    expect(names(documentSymbols(source))).toEqual([['script', ['a', 'n']], 'if a', ['else', ['p#hero']], ['Card', ['@row(item)']]])
  })

  it('folds the fence and every block spanning lines', () => {
    expect(foldingRanges(source)).toEqual([{ startLine: 0, endLine: 3, kind: 'region' }, { startLine: 5, endLine: 8 }, { startLine: 5, endLine: 6 }, { startLine: 9, endLine: 11 }, { startLine: 10, endLine: 11 }])
  })
})

describe('import edits on a rename', () => {
  it('rewrites imports to a moved file and of a moved file, and leaves packages alone', () => {
    const source = '---\nimport Card from \'../components/card.kay\'\nimport { x } from \'kay\'\n---\nCard\n'
    const moves = new Map([['/app/src/components/card.kay', '/app/src/ui/card.kay']])

    expect(importEdits('/app/src/routes/index.kay', source, moves).map(edit => edit.text)).toEqual(['../ui/card.kay'])
    expect(importEdits('/app/src/routes/index.kay', source, new Map([['/app/src/routes/index.kay', '/app/src/routes/a/index.kay']])).map(edit => edit.text)).toEqual(['../../components/card.kay'])
    expect(importEdits('/app/src/routes/index.kay', source, new Map())).toEqual([])
  })
})
