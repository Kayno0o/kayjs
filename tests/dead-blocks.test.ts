import { describe, expect, it } from 'bun:test'
import { specializedSource } from '../src/build/variants'
import { compileKay } from '../src/compiler'

const dom = (template: string) => compileKay(`---\nconst on = true\nconst items = [1]\n---\n${template}\n`, 'src/main.kay', { output: 'dom' }).tsx

describe('a branch whose test is the literal false in the browser output', () => {
  it('has no block of its own, its markers staying in the markup', () => {
    const code = dom('div\n  if false\n    b one\n  p tail')

    expect(code).not.toContain('KayChoose(')
    expect(code).toContain('<!--[--><!--]-->')
  })

  it('leaves a chain with a branch that may hold, minus the false ones', () => {
    const code = dom('div\n  if false\n    b one\n  else if on\n    i two\n  else\n    u three')

    expect(code).toContain('KayChoose(')
    expect(code).not.toContain('<b>one</b>')
    expect(code).toContain('<i>two</i>')
    expect(code).toContain('<u>three</u>')
  })

  it('stays as it was for a test that is not the literal', () => {
    expect(dom('div\n  if on\n    b one')).toContain('KayChoose(')
  })

  it('has no block in a fragment either', () => {
    const code = dom('for item of items\n  if false\n    b one\n  i two')

    expect(code).not.toContain('<b>one</b>')
    expect(code).toContain('KayMarkers(')
  })
})

describe('an aria or data attribute written {undefined}', () => {
  it('is never set, where another attribute is', () => {
    const code = dom('p(aria-rowindex={undefined} data-x={undefined} title={undefined} data-y={on})')

    expect(code).not.toContain('aria-rowindex')
    expect(code).not.toContain('data-x')
    expect(code).toContain('title')
    expect(code).toContain('data-y')
  })
})

describe('specializedSource on an attribute with a false condition', () => {
  const absent = (line: string) => specializedSource(`---\n---\n${line}`, new Set()).split('\n')[2]

  it('writes {undefined} for a ternary whose condition is false and whose else is undefined', () => {
    expect(absent('tr(a={(uses(\'x\') && y) ? f(1, 2) : undefined} b={c ? 1 : undefined})')).toBe('tr(a={undefined} b={c ? 1 : undefined})')
    expect(absent('td(a={uses(\'x\') && y ? { k: 1 } : undefined})')).toBe('td(a={undefined})')
  })

  it('keeps a ternary that may hold, with another else or with a nested one', () => {
    const kept = 'td(a={uses(\'x\') || y ? 1 : undefined} b={uses(\'x\') && y ? 1 : 2} c={uses(\'x\') && y ? 1 : p ? 2 : undefined})'

    expect(absent(kept)).toBe(kept.replaceAll('uses(\'x\')', 'false'))
  })

  it('keeps a handler whose condition sits after an arrow, an assignment or a comma', () => {
    const arrow = 'td(onX={() => s && uses(\'x\') ? run() : undefined} a={(b = uses(\'x\')) && y ? 1 : undefined} c={(p, uses(\'x\')) ? 1 : undefined})'

    expect(absent(arrow)).toBe(arrow.replaceAll('uses(\'x\')', 'false'))
  })

  it('reads a ? or a : or a brace inside a string as text', () => {
    expect(absent('td(a={uses(\'x\') && y ? \'a:b}\' : undefined} b={uses(\'x\') && y ? 1 : undefined})')).toBe('td(a={undefined} b={undefined})')
    expect(absent('td(a={uses(\'x\') && y === \'?\' ? 1 : undefined} b={uses(\'x\') && y ? \'?:\' : undefined})')).toBe('td(a={undefined} b={undefined})')
    expect(absent('td(a={uses(\'x\') && y ? 1 : \'}\'} b={z})')).toBe('td(a={false && y ? 1 : \'}\'} b={z})')
  })

  it('leaves a condition with a template literal holding ${ unfolded', () => {
    expect(absent('td(a={uses(\'x\') && y ? `${z}}` : undefined})')).toBe('td(a={false && y ? `${z}}` : undefined})')
    expect(absent('td(a={uses(\'x\') && y ? `a:b` : undefined})')).toBe('td(a={undefined})')
  })

  it('keeps the true branch when the feature is on', () => {
    expect(specializedSource('---\n---\ntd(a={uses(\'x\') && y ? 1 : undefined})', new Set(['x'])).split('\n')[2]).toBe('td(a={true && y ? 1 : undefined})')
  })
})
