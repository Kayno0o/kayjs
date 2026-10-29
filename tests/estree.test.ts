import { describe, expect, it } from 'bun:test'
import { ParseError, parseExpression, parseProgram, positionOf } from '../src/compiler/estree'

describe('parseProgram', () => {
  it('returns the program of a module in TypeScript, with the positions of the text', () => {
    const { program, errors, comments } = parseProgram('// note\nconst a: number = 1 /* x */')

    expect(errors).toEqual([])
    expect(program.type).toBe('Program')
    expect(program.body[0]!.start).toBe(8)
    expect(comments.map(comment => [comment.type, comment.value, comment.start])).toEqual([['Line', ' note', 0], ['Block', ' x ', 28]])
  })

  it('reads JSX only in tsx and jsx', () => {
    expect(() => parseProgram('const a = <b c="d" />')).toThrow(ParseError)
    expect(parseProgram('const a = <b c="d" />', { lang: 'tsx' }).program.body).toHaveLength(1)
    expect(parseProgram('const a = <b c="d" />', { lang: 'jsx' }).program.body).toHaveLength(1)
  })

  it('shifts every position by the offset, the comments too', () => {
    const { program, comments } = parseProgram('a // c\nb', { offset: 100 })

    expect(program.body.map(statement => [statement.start, statement.end])).toEqual([[100, 101], [107, 108]])
    expect(comments[0]!.start).toBe(102)
  })

  it('points an unclosed brace where the text ends and a redeclaration at the repeat', () => {
    expect(parseProgram('function f() {\n  a()\n', { recover: true }).errors[0]!.pos).toBeGreaterThan(18)
    expect(parseProgram('const a = 1\nconst a = 2\n', { recover: true, semantic: true }).errors[0]!.pos).toBe(18)
  })

  it('throws the first error with its position, or returns every error with recover', () => {
    const error = (() => {
      try {
        parseProgram('const a = 1 +\n', { offset: 10 })
      }
      catch (thrown) {
        return thrown as ParseError
      }

      return undefined
    })()

    expect(error).toBeInstanceOf(SyntaxError)
    expect(error!.message).toBe('Unexpected token')
    expect(error!.pos).toBe(24)

    const { errors, program } = parseProgram('const a = 1 +\n', { recover: true })

    expect(errors).toEqual([{ pos: 14, message: 'Unexpected token' }])
    expect(program.body).toEqual([])
  })

  it('lets a return outside a function pass on request', () => {
    expect(() => parseProgram('return 1')).toThrow('return')
    expect(parseProgram('return 1', { returnOutside: true }).program.body).toHaveLength(1)
  })

  it('reports a name declared twice only on request', () => {
    expect(parseProgram('let a; let a').errors).toEqual([])
    expect(parseProgram('let a; let a', { semantic: true, recover: true }).errors.map(error => error.message)).toEqual(['Identifier `a` has already been declared'])
  })

  it('drops parentheses unless asked to keep them', () => {
    const dropped = parseProgram('(a)').program.body[0]
    const kept = parseProgram('(a)', { parens: true }).program.body[0]

    expect(dropped).toMatchObject({ expression: { type: 'Identifier', start: 1 } })
    expect(kept).toMatchObject({ expression: { type: 'ParenthesizedExpression', start: 0 } })
  })

  it('measures positions in UTF-16 units', () => {
    expect(parseProgram('"é😀"; foo').program.body[1]!.start).toBe(7)
  })
})

describe('parseExpression', () => {
  it('returns the expression with its own positions, shifted by the offset', () => {
    expect(parseExpression('a + b')).toMatchObject({ type: 'BinaryExpression', start: 0, end: 5 })
    expect(parseExpression('  a + b ', { offset: 10 })).toMatchObject({ type: 'BinaryExpression', start: 12, end: 17 })
    expect(parseExpression('(a)')).toMatchObject({ type: 'Identifier', start: 1, end: 2 })
  })

  it('reads an object, a sequence, an arrow with type arguments and a trailing line comment', () => {
    expect(parseExpression('{ a: 1 }').type).toBe('ObjectExpression')
    expect(parseExpression('a, b').type).toBe('SequenceExpression')
    expect(parseExpression('<T>(x: T) => x').type).toBe('ArrowFunctionExpression')
    expect(parseExpression('a // note').type).toBe('Identifier')
    expect(parseExpression('<a b="c" />', { lang: 'jsx' }).type).toBe('JSXElement')
  })

  it('refuses what is not exactly one expression', () => {
    for (const code of ['a b', 'a; b', 'a) + (b', 'a), (b', '', 'const a = 1', 'a +'])
      expect(() => parseExpression(code)).toThrow(ParseError)
  })

  it('reports where it fails in the text, past the offset', () => {
    try {
      parseExpression('a + )', { offset: 50 })
    }
    catch (error) {
      expect((error as ParseError).pos).toBe(54)
    }
  })
})

describe('positionOf', () => {
  it('gives the line from 1 and the column from 0', () => {
    expect(positionOf('ab\ncd\n\nef', 0)).toEqual({ line: 1, column: 0 })
    expect(positionOf('ab\ncd\n\nef', 4)).toEqual({ line: 2, column: 1 })
    expect(positionOf('ab\ncd\n\nef', 7)).toEqual({ line: 4, column: 0 })
  })
})
