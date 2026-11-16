import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

function run(source: string) {
  const found = compileKay(source, 'card.kay', { check: true }).diagnostics.filter(d => d.code === 'deprecated-children-prop')
  const edits = found.flatMap(d => d.fixes?.[0]?.edits ?? []).toSorted((a, b) => b.start - a.start)

  return { at: found.map(d => source.slice(d.start, d.end)), fixed: edits.reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source) }
}

const wrap = (type: string, body = 'slot') => `---\nimport type { Snippet } from 'kay'\n\nconst { title } = props<${type}>()\n---\nsection\n  h2 {title}\n  ${body}\n`

describe('deprecated-children-prop', () => {
  it.each([
    ['last', '{ title: string, children?: Snippet }', '{ title: string }'],
    ['first', '{ children?: Snippet, title: string }', '{ title: string }'],
    ['among others', '{ title: string, children?: Snippet, open?: boolean }', '{ title: string, open?: boolean }'],
    ['with semicolons', '{ title: string; children?: Snippet; open?: boolean }', '{ title: string; open?: boolean }'],
    ['multi-line', '{\n  title: string\n  children?: Snippet\n}', '{\n  title: string\n}'],
  ])('removes the member written %s', (_, type, expected) => {
    const result = run(wrap(type))

    expect(result.at).toEqual(['children?: Snippet'])
    expect(result.fixed).toBe(wrap(expected).replace('import type { Snippet } from \'kay\'\n\n', ''))
  })

  it('keeps an import another name or use still needs', () => {
    const source = '---\nimport type { Snippet, Signal } from \'kay\'\n\nconst { title, actions } = props<{ title: string, actions?: Snippet, children?: Snippet }>()\n---\nsection\n  slot\n'

    expect(run(source).fixed).toBe(source.replace(', children?: Snippet', ''))
    expect(run('---\nimport type { Snippet, Signal } from \'kay\'\n\nconst { title } = props<{ title: string, children?: Snippet }>()\n---\nsection\n  slot\n').fixed).toBe('---\nimport type { Signal } from \'kay\'\n\nconst { title } = props<{ title: string }>()\n---\nsection\n  slot\n')
  })

  it('leaves a required children, a block, a read of children and a template with no bare slot', () => {
    expect(run(wrap('{ title: string, children: Snippet }')).at).toEqual([])
    expect(run(wrap('{ title: string, children?: Snippet }', 'slot actions')).at).toEqual([])
    expect(run(wrap('{ title: string, children?: Snippet }', 'p no slot')).at).toEqual([])
    expect(run('---\nimport type { Snippet } from \'kay\'\nconst { title, children } = props<{ title: string, children?: Snippet }>()\n---\nsection\n  h2 {title}\n  slot\n').at).toEqual([])
    expect(run('---\nimport type { Snippet } from \'kay\'\nconst all = props<{ title: string, children?: Snippet }>()\n---\nsection\n  h2 {all.title}\n  slot\n').at).toEqual([])
  })
})
