import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'

const HEAD = '---\nconst { user, list, a, b } = props<{ user: { name: string } | null, list: { id: number }[], a: number, b: string }>()\n---\n'

function run(template: string) {
  const source = `${HEAD}${template}\n`
  const { diagnostics } = compileKay(source, 'page.kay', { check: true })
  const lints = diagnostics.filter(d => d.code === 'deprecated-if-alias')
  const errors = diagnostics.filter(d => d.checkOnly !== true)
  const edits = lints.flatMap(d => d.fixes?.[0]?.edits ?? []).sort((x, y) => y.start - x.start)

  return { at: lints.map(d => source.slice(d.start, d.end)), safe: lints.map(d => d.fixes?.[0]?.safe), errors, fixed: edits.reduce((text, edit) => `${text.slice(0, edit.start)}${edit.text}${text.slice(edit.end)}`, source).slice(HEAD.length).trim() }
}

describe('deprecated-if-alias', () => {
  it('rewrites an as alias to then, on an if and an else if', () => {
    const result = run('if user as u\n  p {u.name}\nelse if list.find(x => x.id === a) as item\n  p {item.id}')

    expect(result.at).toEqual(['as', 'as'])
    expect(result.safe).toEqual([true, true])
    expect(result.fixed).toBe('if user then u\n  p {u.name}\nelse if list.find(x => x.id === a) then item\n  p {item.id}')
  })

  it('leaves a cast, an alias written with then and a cast inside brackets alone', () => {
    expect(run('if a as unknown\n  p x\nif (user as { name: string } | null)\n  p x\nif b as const\n  p x').at).toEqual([])
    expect(run('if user then u\n  p {u.name}\nif a == 1 && b === \'then z\' then w\n  p {w}').at).toEqual([])
  })

  it('aliases with then whatever operators the condition holds, a comment after it, and a name in any case', () => {
    const result = run('if a && user then u\n  p {u.name}\nif a ? b : null then label\n  p {label}\nif user then User\n  p {User.name}\nif (user as unknown) then k // the user\n  p x')

    expect(result.errors).toEqual([])
    expect(result.at).toEqual([])
  })

  it('reports then with no name or with two', () => {
    expect(run('if user then\n  p x').errors.map(e => e.code)).toEqual(['template-syntax'])
    expect(run('if user then u v\n  p x').errors.map(e => e.code)).toEqual(['template-syntax'])
  })
})
