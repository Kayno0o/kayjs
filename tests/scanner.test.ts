import { describe, expect, it } from 'bun:test'
import { Scanner } from '../src/compiler/scanner'

function scanner(src: string): { scan: Scanner, errors: string[] } {
  const errors: string[] = []

  return { scan: new Scanner(src, (start, end, message) => errors.push(`${src.slice(start, end)} ${message}`)), errors }
}

// Where the bracket opening `src` closes, and what went wrong on the way.
function balanced(src: string): [string, string[]] {
  const { scan, errors } = scanner(src)

  return [src.slice(0, scan.balanced(0)), errors]
}

describe('balanced', () => {
  it('steps over the brackets strings, template literals and comments hold', () => {
    expect(balanced('{a(\'}\')} rest')).toEqual(['{a(\'}\')}', []])
    expect(balanced('{`${\'}\'}` + `}`} rest')).toEqual(['{`${\'}\'}` + `}`}', []])
    expect(balanced('{/* } */ a} rest')).toEqual(['{/* } */ a}', []])
    expect(balanced('{a // }\n} rest')).toEqual(['{a // }\n}', []])
    expect(balanced('{x.replace(/[}]/g, \'\')} rest')).toEqual(['{x.replace(/[}]/g, \'\')}', []])
  })

  it('reads a / after a ) as a division, so what follows is code', () => {
    expect(balanced('{(a) / b + "x/"} rest')).toEqual(['{(a) / b + "x/"}', []])
    expect(balanced('{f(a) / 2 / f(b)} rest')).toEqual(['{f(a) / 2 / f(b)}', []])
  })

  it('reads a / after a } as a regex, as a statement may follow a block', () => {
    expect(balanced('{ if (a) {} /}/.test(b) } rest')).toEqual(['{ if (a) {} /}/.test(b) }', []])
  })

  it('reports a bracket that closes another, and one never closed', () => {
    expect(balanced('{a)')).toEqual(['{a)', [') Unbalanced `)`']])
    expect(balanced('{a')).toEqual(['{a', ['{ Unclosed `{`']])
  })
})

describe('regex', () => {
  const end = (src: string, at = src.indexOf('/')) => scanner(src).scan.regex(0, at)

  it('starts where an operand is expected', () => {
    expect(end('x = /a b/g.test(y)')).toBe('x = /a b/g'.length)
    expect(end('return /a/')).toBe('return /a/'.length)
    expect(end('/a/ at the start')).toBe(3)
    expect(end('{} /a/')).toBe('{} /a/'.length)
    expect(end('x = /[/]/')).toBe('x = /[/]/'.length)
    expect(end('x = /\\//')).toBe('x = /\\//'.length)
  })

  it('divides after an operand, and when the literal would not close on its line', () => {
    expect(end('(a) / 2 / 3')).toBe(-1)
    expect(end('a / 2 / 3')).toBe(-1)
    expect(end('a++ / 2 / 1')).toBe(-1)
    expect(end('x = /a\n/')).toBe(-1)
  })
})

describe('strings and template literals', () => {
  it('stop a string at the end of its line, and step over escapes', () => {
    const { scan } = scanner('\'a\\\'b\' "c\nd"')

    expect(scan.string(0, '\'')).toBe(6)
    expect(scan.string(7, '"')).toBe(9)
  })

  it('step over the substitutions of a template literal, nested ones too', () => {
    const src = '`a${`b${c}`}d` rest'
    const { scan, errors } = scanner(src)

    expect([src.slice(0, scan.template(0)), errors]).toEqual(['`a${`b${c}`}d`', []])
    expect(scanner('`a').scan.template(0)).toBe(2)
  })
})
